/**
 * Standalone benchmark for the deterministic evaluation layer.
 * bun examples/benchmark-evaluation.ts [pure|watch|append]
 * Prints one JSON object; exit 1 when a gate fails. Temp fixtures only.
 * Run under the service quota with systemd-run -p CPUQuota=25% -p MemoryMax=512M.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateOperation } from "../src/core/evaluation.ts";
import { foldEvents } from "../src/core/fold.ts";
import { computeStats } from "../src/core/stats.ts";
import { appendEvent } from "../src/store/events.ts";
import type { Event, Operation } from "../src/core/types.ts";
import { operationDir } from "../src/paths.ts";

const SEED = 0x104;
const rand = (() => { let s = SEED; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const rchar = () => Number(readFileSync("/proc/self/io", "utf8").match(/rchar: (\d+)/)![1]);
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; // ms
const rss = () => process.memoryUsage().rss;
const percentile = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)]; };
const dist = (xs: number[]) => ({ p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: Math.max(...xs) });

const gates: { failures: string[]; record: (name: string, value: number, budget: number, unit?: string) => void } = {
  failures: [],
  record(name, value, budget, unit = "ms") {
    const pass = value <= budget;
    if (!pass) this.failures.push(`${name}: ${value}${unit} > ${budget}${unit}`);
    gateReport[name] = { value, budget, unit, pass };
  },
};
const gateReport: Record<string, { value: number; budget: number; unit: string; pass: boolean }> = {};

function makeOperation(contacts: number): Operation {
  return {
    v: 1, id: "bench", name: "Bench", repo: "/repo", base: "main", integration: "/repo",
    pause: false, ignoreChecks: false, tracker: "none", fleet: "omp-mission", frontend: "none",
    delivery: "none", zones: [{ id: "z1", label: "Z" }],
    contacts: Array.from({ length: contacts }, (_, i) => ({
      ticket: `c${i}`, title: null, zone: "z1", kind: "implement", blockedBy: [], conflictOf: null, lane: null,
    })),
    project: null, createdAt: "2025-12-31T00:00:00.000Z", recover: false,
  };
}

/** Deterministic history: queue→launch→samples→land for most contacts, then close. */
function makeEvents(contacts: number, samples: number): Event[] {
  const events: Event[] = [];
  let t = 1_700_000_000_000;
  const at = () => new Date(t += 1000).toISOString();
  for (let i = 0; i < contacts; i++) {
    events.push({ v: 1, at: at(), kind: "queued", contact: `c${i}` });
    events.push({ v: 1, at: at(), kind: "launched", contact: `c${i}`, worktree: "/w", frontend: "none", terminal: { handle: "h", incarnationId: "i" } });
  }
  for (let i = 0; i < samples; i++) {
    const c = `c${i % contacts}`;
    events.push({ v: 1, at: at(), kind: "phase", contact: c, from: null, to: i % 2 ? "execute" : "review" });
    events.push({
      v: 1, at: at(), kind: "sample", contact: c,
      workers: i % 4, omp: 8, usage: { tokens: { input: i, output: i, cacheRead: 0, cacheWrite: 0 }, costUsd: null },
    });
  }
  for (let i = 0; i < contacts; i++) events.push({ v: 1, at: at(), kind: "landed", contact: `c${i}`, via: "manual" });
  events.push({ v: 1, at: at(), kind: "closed", outcome: "landed" });
  void rand;
  return events;
}

interface RunResult { events: number; baseline: ReturnType<typeof dist>; addedEvaluation: ReturnType<typeof dist>; jsonParse: ReturnType<typeof dist> }
function benchPure(): Record<string, unknown> {
  const run = (contacts: number, samples: number, reps: number): RunResult => {
    const op = makeOperation(contacts), events = makeEvents(contacts, samples);
    const clock = Date.parse(events.at(-1)!.at);
    const baseline: number[] = [], added: number[] = [], parsed: number[] = [];
    const json = JSON.stringify(events);
    for (let i = 0; i < 5 + reps; i++) {
      const warm = i < 5;
      let c0 = cpu();
      const d1 = foldEvents(events); computeStats(d1, clock, 8);
      if (!warm) baseline.push(cpu() - c0);
      c0 = cpu();
      const d2 = foldEvents(events); evaluateOperation(op, d2, clock);
      if (!warm) added.push(cpu() - c0);
      c0 = cpu();
      JSON.parse(json);
      if (!warm) parsed.push(cpu() - c0);
    }
    return { events: events.length, baseline: dist(baseline), addedEvaluation: dist(added), jsonParse: dist(parsed) };
  };
  const normal = run(64, 9_700, 50), stress = run(100, 49_700, 20);
  const add95 = normal.addedEvaluation.p95;
  const base95 = normal.baseline.p95;
  gates.record("pure normal p95 cpu", add95, base95 < 25 ? Math.max(5, base95 * 1.2) : base95 * 1.2);
  gates.record("pure stress p95 cpu", stress.addedEvaluation.p95, Math.max(25, stress.baseline.p95 * 1.2));
  const normalRss = rss();
  run(64, 9_700, 3);
  gates.record("pure incremental rss", Math.round((rss() - normalRss) / 1_048_576), 16, "MiB");
  return { normal, stress };
}

async function benchWatch(dir: string): Promise<Record<string, unknown>> {
  // 8 ops × 16 contacts × 10k events: replay the watcher's per-pass fold+evaluate cost.
  const ops: { op: Operation; events: Event[] }[] = [];
  let total = 0;
  for (let o = 0; o < 8; o++) {
    const op = makeOperation(16);
    const events = makeEvents(16, 9_967);
    total += events.length;
    ops.push({ op, events });
  }
  const perPass: number[] = [], bytes: number[] = [];
  for (let i = 0; i < 100; i++) {
    const b0 = rchar(), c0 = cpu();
    for (const { op, events } of ops) {
      const derived = foldEvents(events);
      evaluateOperation(op, derived, Date.parse(events.at(-1)!.at));
    }
    if (i >= 3) { perPass.push((cpu() - c0) / ops.length); bytes.push(rchar() - b0); }
  }
  // Whole-file fold per pass is the existing cost; evaluation must stay in the same envelope.
  gates.record("watch per-op pass p95 cpu", percentile(perPass, 0.95), 25);
  // Event files are already in memory here; the gate is that evaluation itself does no reads.
  gates.record("watch evaluation reads per pass", Math.max(...bytes), 64 * 1024, "B");
  return { operations: ops.length, eventsPerOperation: ops[0]!.events.length, total, perPassMs: dist(perPass), readBytesPerPass: dist(bytes) };
}

async function benchAppend(dir: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const sizes = [1, 8, 32].map((m) => m * 1024 * 1024);
  for (const target of sizes) {
    const opId = `app-${target}`;
    mkdirSync(operationDir(dir, opId), { recursive: true });
    const file = join(operationDir(dir, opId), "events.jsonl");
    // Stream a clean history to target size in <=64 KiB writes.
    let written = 0, seq = 0;
    while (written < target) {
      const lines: string[] = [];
      let chunk = 0;
      while (chunk < 64 * 1024) {
        const line = JSON.stringify({ v: 1, at: "2026-01-01T00:00:00.000Z", kind: "queued", contact: `c${seq++ % 16}` }) + "\n";
        lines.push(line); chunk += line.length;
      }
      const text = lines.join("");
      writeFileSync(file, text, { flag: "a" });
      written += text.length;
    }
    const e: Event = { v: 1, at: "2026-01-02T00:00:00.000Z", kind: "queued", contact: "c" };
    const r0 = rchar();
    const times: number[] = [], reads: number[] = [];
    for (let i = 0; i < 100; i++) {
      const b0 = rchar(), c0 = cpu();
      await appendEvent(dir, opId, e);
      times.push(cpu() - c0); reads.push(rchar() - b0);
    }
    const warmReads = reads.slice(1); // first append in this process may pay open/stat setup
    // repairTail reads only the tail: a small constant, independent of file size.
    gates.record(`append tail-read bytes @${target / 1048576}MiB`, Math.max(...warmReads), 4096, "B");
    const c0 = cpu();
    await Promise.all(Array.from({ length: 100 }, () => appendEvent(dir, opId, e)));
    out[`${target / 1048576}MiB`] = {
      sequential: { ms: dist(times), bytesPerAppend: dist(reads) },
      concurrent100: { msTotal: cpu() - c0 },
    };
  }
  // Torn tail: repair reads must stay proportional to the fragment, never the whole file.
  {
    const opId = "torn";
    mkdirSync(operationDir(dir, opId), { recursive: true });
    const file = join(operationDir(dir, opId), "events.jsonl");
    const head = JSON.stringify({ v: 1, at: "2026-01-01T00:00:00.000Z", kind: "queued", contact: "a" }) + "\n";
    const fragment = 200 * 1024;
    writeFileSync(file, head + "x".repeat(fragment));
    const b0 = rchar();
    await appendEvent(dir, opId, { v: 1, at: "2026-01-02T00:00:00.000Z", kind: "queued", contact: "b" });
    gates.record("torn tail scratch read", rchar() - b0 - head.length, fragment + 4096, "B");
  }
  return out;
}

const modes = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const want = modes.length ? modes : ["pure", "watch", "append"];
const dir = mkdtempSync(join(tmpdir(), "holotable-bench-"));
const modeResults: Record<string, unknown> = {};
const result = {
  tool: "benchmark-evaluation", bun: Bun.version, platform: process.platform, arch: process.arch,
  seed: SEED, modes: modeResults, gates: gateReport, failures: gates.failures,
};
try {
  if (want.includes("pure")) modeResults.pure = benchPure();
  if (want.includes("watch")) modeResults.watch = await benchWatch(dir);
  if (want.includes("append")) modeResults.append = await benchAppend(dir);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(result));
if (gates.failures.length) process.exit(1);
