// Usage snapshots are shared across viewers, including requests for different operations.
// Sampling /proc and resolving lane roots happens at most once per cache window.
import { realpath } from "node:fs/promises";
import { buildUsage, type MachineSample, type UsageReport } from "./core/usage.ts";
import { sampleMachine, usableMemoryBytes } from "./machine.ts";
import { listOperations, readOperationDoc } from "./store/operations.ts";

const STALE_MS = 10_000;
const SAMPLE_GAP_MS = 300;
const CACHE_MS = 1_000;

export interface UsageDeps {
  home: string;
  sample?: () => MachineSample;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function createUsage(deps: UsageDeps): (opId: string | null) => Promise<UsageReport> {
  const { home } = deps;
  const sample = deps.sample ?? (() => sampleMachine());
  const sleep =
    deps.sleep ??
    ((ms: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    });
  const now = deps.now ?? Date.now;
  let prev: MachineSample | null = null;
  type Snapshot = {
    base: MachineSample | null;
    next: MachineSample;
    roots: Map<string, string[]>;
    allRoots: string[];
    memory: number;
    reports: Map<string | null, UsageReport>;
  };
  let cache: { at: number; snapshot: Snapshot } | null = null;
  let inFlight: Promise<Snapshot> | null = null;

  /** The pair CPU deltas are computed against: the kept sample, or two fresh ones. */
  async function pair(): Promise<{ prev: MachineSample | null; next: MachineSample }> {
    const before = prev;
    const next = sample();
    if (before && next.at - before.at <= STALE_MS) return { prev: before, next };
    // No usable baseline: sample once more after a short gap so rates have a window.
    await sleep(SAMPLE_GAP_MS);
    const later = sample();
    return { prev: next, next: later };
  }

  async function refresh(): Promise<Snapshot> {
    const { prev: base, next } = await pair();
    const rows = await listOperations(home);
    const roots = new Map<string, string[]>();
    await Promise.all(rows.map(async ({ id }) => {
      const doc = await readOperationDoc(home, id);
      const worktrees = new Set(doc.operation.contacts.flatMap((c) => c.lane ? [c.lane.worktree] : []));
      const resolved = await Promise.all([...worktrees].map((wt) => realpath(wt).catch(() => null)));
      roots.set(id, resolved.filter((wt): wt is string => wt !== null));
    }));
    const snapshot: Snapshot = {
      base, next, roots,
      allRoots: [...new Set([...roots.values()].flat())],
      memory: usableMemoryBytes(),
      reports: new Map(),
    };
    prev = next;
    cache = { at: now(), snapshot };
    return snapshot;
  }

  return async (opId) => {
    let snapshot: Snapshot;
    if (cache && now() - cache.at < CACHE_MS) {
      snapshot = cache.snapshot;
    } else {
      inFlight ??= refresh().finally(() => { inFlight = null; });
      snapshot = await inFlight;
    }
    const cached = snapshot.reports.get(opId);
    if (cached) return cached;
    const roots = opId === null ? null : snapshot.roots.get(opId) ?? [];
    const report = buildUsage(snapshot.base, snapshot.next, roots, snapshot.allRoots, snapshot.memory);
    snapshot.reports.set(opId, report);
    return report;
  };
}
