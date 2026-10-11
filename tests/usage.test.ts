import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { attributeProcesses, buildUsage, CLK_TCK, machineUsage, pathInside, usageFor, type MachineSample, type ProcInfo } from "../src/core/usage.ts";
import { createUsage } from "../src/usage.ts";
import { createBoardService } from "../src/board.ts";
import { startServer, type BoardServer } from "../src/server.ts";
import { lane, contact, removeAll, seedOperation, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

const proc = (pid: number, over: Partial<ProcInfo> = {}): ProcInfo => ({
  pid,
  ppid: 1,
  cwd: null,
  ticks: 0,
  rss: null,
  ...over,
});

const sample = (over: Partial<MachineSample> = {}): MachineSample => ({
  at: 0,
  cpuTicks: null,
  memTotalBytes: null,
  memAvailableBytes: null,
  cpuCount: 4,
  procs: [],
  ...over,
});

test("pathInside matches the root and children, not siblings or prefixes", () => {
  expect(pathInside("/wt/a", "/wt/a")).toBe(true);
  expect(pathInside("/wt/a", "/wt/a/deep/dir")).toBe(true);
  expect(pathInside("/wt/a", "/wt/abc")).toBe(false);
  expect(pathInside("/wt/a", "/wt")).toBe(false);
  expect(pathInside("/wt/a/", "/wt/a/x")).toBe(true);
});

test("attributeProcesses finds cwd hits and their whole descendant tree, deduplicated", () => {
  const procs = [
    proc(10, { cwd: "/wt/a" }), // direct hit
    proc(11, { ppid: 10, cwd: "/elsewhere" }), // descendant, no matching cwd
    proc(12, { ppid: 11, cwd: "/elsewhere/deeper" }), // grandchild
    proc(20, { cwd: "/wt/b" }), // second root's hit
    proc(21, { ppid: 20, cwd: "/wt/a" }), // matched by both roots: counted once
    proc(30, { cwd: "/outside" }), // unrelated
    proc(31, { ppid: 30, cwd: "/wt/a/sub" }), // cwd match despite non-matching parent
  ];
  const pids = attributeProcesses(procs, ["/wt/a", "/wt/b"]);
  expect([...pids].sort((a, b) => a - b)).toEqual([10, 11, 12, 20, 21, 31]);
});

test("attributeProcesses ignores unreadable cwds and unknown roots", () => {
  const procs = [proc(1, { cwd: null }), proc(2, { cwd: "/wt/a", ppid: 1 })];
  expect([...attributeProcesses(procs, ["/nope"])]).toEqual([]);
  expect([...attributeProcesses(procs, [])]).toEqual([]);
});

test("usageFor computes cpu share of the machine and summed rss", () => {
  const prev = sample({ at: 0, procs: [proc(10, { ticks: 0, rss: 1000 }), proc(11, { ticks: 0 })] });
  const next = sample({ at: 1000, procs: [proc(10, { ticks: 50, rss: 2000 }), proc(11, { ticks: 50, rss: 3000 })] });
  const stats = usageFor(prev, next, attributeProcesses(next.procs, []), 10_000);
  // No roots → no pids.
  expect(stats.processes).toBe(0);
  const pids = new Set([10, 11]);
  const s = usageFor(prev, next, pids, 10_000);
  // 100 ticks over 1 s on 4 cpus: 100 / (1 * 100 * 4) * 100 = 25%.
  expect(s.cpuPct).toBe(25);
  expect(s.memBytes).toBe(5000);
  expect(s.memPct).toBe(50);
  expect(s.processes).toBe(2);
});

test("usageFor degrades: no previous sample, exited pids, missing rss, shrinking ticks", () => {
  const next = sample({ at: 1000, procs: [proc(10, { ticks: 50, rss: null })] });
  const fresh = usageFor(null, next, new Set([10]), 1_000_000);
  expect(fresh.cpuPct).toBeNull();
  expect(fresh.memBytes).toBe(0);
  // A pid that vanished between samples contributes nothing.
  const gone = usageFor(sample({ at: 0, procs: [proc(9, { ticks: 100 })] }), next, new Set([9]), 1_000_000);
  expect(gone.processes).toBe(1);
  expect(gone.memBytes).toBe(0);
  expect(gone.cpuPct).toBe(0);
  // Ticks going backwards (pid reuse) clamp to zero, never negative.
  const prev = sample({ at: 0, procs: [proc(10, { ticks: 500 })] });
  expect(usageFor(prev, next, new Set([10]), 1_000_000).cpuPct).toBe(0);
  // No memory figure at all → null pct.
  expect(usageFor(prev, next, new Set([10]), null).memPct).toBeNull();
});

test("machineUsage reports busy cpu and MemTotal - MemAvailable", () => {
  const prev = sample({ at: 0, cpuTicks: { total: 1000, idle: 800 } });
  const next = sample({
    at: 2000,
    cpuTicks: { total: 2000, idle: 1300 }, // 500 busy of 1000 new jiffies → 50%
    memTotalBytes: 8000,
    memAvailableBytes: 2000,
    cpuCount: 8,
  });
  const m = machineUsage(prev, next);
  expect(m.cpuPct).toBe(50);
  expect(m.memUsedBytes).toBe(6000);
  expect(m.memPct).toBe(75);
  expect(m.cpus).toBe(8);
  expect(machineUsage(null, next).cpuPct).toBeNull();
});

test("buildUsage shapes the route answer", () => {
  const prev = sample({ at: 0, cpuTicks: { total: 0, idle: 0 }, procs: [proc(10, { ticks: 0 })] });
  const next = sample({
    at: 1000,
    cpuTicks: { total: 400, idle: 300 },
    memTotalBytes: 100_000,
    memAvailableBytes: 50_000,
    procs: [proc(10, { cwd: "/wt/a", ticks: 40, rss: 500 })],
  });
  const report = buildUsage(prev, next, ["/wt/a"], ["/wt/a"], 10_000);
  expect(report.op?.cpuPct).toBeCloseTo(10); // 40 / (1*100*4)
  expect(report.op?.processes).toBe(1);
  expect(report.all).toEqual(report.op!);
  expect(report.machine.cpuPct).toBe(25);
  expect(buildUsage(prev, next, null, ["/wt/a"], 10_000).op).toBeNull();
});

test("createUsage attributes lane worktrees and keeps a baseline between calls", async () => {
  const home = tempDir("usage", dirs);
  const wt = join(home, "wt-a");
  mkdirSync(wt);
  await seedOperation(home, { contacts: [contact("a", { lane: lane(wt) }), contact("b")] });
  const root = realpathSync(wt);
  const shots: MachineSample[] = [
    sample({ at: 0, cpuTicks: { total: 0, idle: 0 }, procs: [proc(10, { cwd: root, ticks: 0, rss: 0 })] }),
    sample({ at: 1000, cpuTicks: { total: 400, idle: 300 }, procs: [proc(10, { cwd: root, ticks: 100, rss: 1024 ** 2 })] }),
    sample({ at: 2000, cpuTicks: { total: 800, idle: 700 }, procs: [proc(10, { cwd: root, ticks: 100, rss: 2 * 1024 ** 2 })] }),
  ];
  let shot = 0;
  let nowMs = 0;
  const sleepCalls: number[] = [];
  const usage = createUsage({
    home,
    sample: () => shots[Math.min(shot++, shots.length - 1)]!,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      nowMs += ms;
    },
    now: () => nowMs,
  });
  const report = await usage("lab");
  expect(sleepCalls).toEqual([300]); // no baseline: two samples 300 ms apart
  // 0→100 ticks over 1 s on 4 cpus = 25% of the machine.
  expect(report.op?.processes).toBe(1);
  expect(report.op?.cpuPct).toBeCloseTo(25);
  expect(report.op?.memBytes).toBe(1024 ** 2);
  expect(report.all).toEqual(report.op!);
  expect(report.machine.cpuPct).toBe(25);
  // Past the cache window a fresh sample reuses the kept baseline (no extra sleep).
  nowMs += 2000;
  const again = await usage("lab");
  expect(sleepCalls).toEqual([300]);
  expect(again.op?.cpuPct).toBe(0); // ticks and busy jiffies were flat
  expect(again.op?.memBytes).toBe(2 * 1024 ** 2);
  // No op parameter: only the "all" and "machine" rows.
  expect((await usage(null)).op).toBeNull();
});

test("concurrent viewers share one usage snapshot without shifting each other's CPU baseline", async () => {
  const home = tempDir("usage-viewers", dirs);
  const wt = join(home, "wt");
  mkdirSync(wt);
  await seedOperation(home, { contacts: [contact("a", { lane: lane(wt) })] });
  const root = realpathSync(wt);
  let scans = 0;
  const usage = createUsage({
    home,
    sample: () => {
      const n = scans++;
      return sample({
        at: n * 1000,
        cpuTicks: { total: n * 400, idle: n * 300 },
        procs: [proc(10, { cwd: root, ticks: n * 100, rss: (n + 1) * 1024 })],
      });
    },
    sleep: async () => {},
    now: () => 0,
  });
  const [selected, global, otherTab] = await Promise.all([usage("lab"), usage(null), usage("lab")]);
  expect(selected.op?.cpuPct).toBe(25);
  expect(global.all).toEqual(selected.all);
  expect(otherTab.op).toEqual(selected.op);
  expect(scans).toBe(2);
});

test("GET /api/usage answers the report shape and 404s unknown operations", async () => {
  const home = tempDir("usage-route", dirs);
  await seedOperation(home, { contacts: [contact("a")] });
  const report = {
    op: { cpuPct: 12, memBytes: 2_400_000_000, memPct: 30, processes: 4 },
    all: { cpuPct: 19, memBytes: 3_600_000_000, memPct: 45, processes: 6 },
    machine: { cpuPct: 61, memUsedBytes: 6_200_000_000, memTotalBytes: 8_000_000_000, memPct: 78, cpus: 4 },
  };
  const seen: Array<string | null> = [];
  const server: BoardServer = await startServer({
    service: createBoardService(home, {
      usage: async (opId) => {
        seen.push(opId);
        return report;
      },
    }),
    settings: { access: "local", port: 0 },
  });
  try {
    const url = new URL(server.url);
    const api = (path: string) =>
      fetch(`${url.protocol}//${url.host}${path}`, { headers: { "x-holotable-token": url.hash.slice(1) } });
    const res = await api("/api/usage?op=lab");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(report);
    expect((await api("/api/usage?op=nope")).status).toBe(404);
    const bare = await api("/api/usage");
    expect(bare.status).toBe(200);
    expect(seen).toEqual(["lab", null]); // "nope" 404s inside the service before the hook
    // Without a usage hook the route is absent, not a 500.
    const plain: BoardServer = await startServer({
      service: createBoardService(home),
      settings: { access: "local", port: 0 },
    });
    try {
      const url2 = new URL(plain.url);
      const res2 = await fetch(`${url2.protocol}//${url2.host}/api/usage?op=lab`, {
        headers: { "x-holotable-token": url2.hash.slice(1) },
      });
      expect(res2.status).toBe(404);
    } finally {
      await plain.close();
    }
  } finally {
    await server.close();
  }
});
