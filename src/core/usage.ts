// Usage attribution, pure. `machine.ts` produces `MachineSample` snapshots from /proc; this
// module turns two snapshots plus a set of lane worktree roots into per-operation CPU and
// memory figures. Nothing here reads the filesystem or a clock: callers pass snapshots.
//
// One process is attributed to an operation when its cwd is inside one of the operation's
// lane worktrees (already realpath'ed), or it descends from such a process. CPU% is the
// processes' share of the whole machine: ticks delta / (elapsed * CLK_TCK * cpuCount) * 100.

export const CLK_TCK = 100;

export interface CpuTicks {
  total: number;
  idle: number;
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Realpath'ed cwd; null when unreadable (kernel threads, races). Never matches a root. */
  cwd: string | null;
  /** utime + stime jiffies. */
  ticks: number;
  /** Resident set in bytes; null when statm was unreadable. */
  rss: number | null;
}

export interface MachineSample {
  /** Snapshot time (ms); deltas divide by the difference. */
  at: number;
  cpuTicks: CpuTicks | null;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  cpuCount: number;
  procs: ProcInfo[];
}

export interface UsageStats {
  cpuPct: number | null;
  memBytes: number;
  memPct: number | null;
  /** Attributed process count (unique pids). */
  processes: number;
}

export interface MachineUsage {
  cpuPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  memPct: number | null;
  cpus: number;
}

export interface UsageReport {
  op: UsageStats | null;
  all: UsageStats;
  machine: MachineUsage;
}

/** `child` is `root` itself or a path underneath it. Both are expected realpath'ed. */
export function pathInside(root: string, child: string): boolean {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return child === base || child.startsWith(`${base}/`);
}

/**
 * Pids attributed to the roots: every process whose cwd sits inside a root, plus all
 * descendants over the ppid tree. The result set is unique by construction.
 */
export function attributeProcesses(procs: readonly ProcInfo[], roots: readonly string[]): Set<number> {
  const attributed = new Set<number>();
  if (roots.length === 0) return attributed;
  const byParent = new Map<number, number[]>();
  for (const proc of procs) {
    const cwd = proc.cwd;
    if (cwd && roots.some((root) => pathInside(root, cwd))) attributed.add(proc.pid);
    const siblings = byParent.get(proc.ppid);
    if (siblings) siblings.push(proc.pid);
    else byParent.set(proc.ppid, [proc.pid]);
  }
  // A queue seeded from the roots' pids walks the whole ppid tree once.
  const queue = [...attributed];
  for (let head = 0; head < queue.length; head++) {
    for (const pid of byParent.get(queue[head] as number) ?? []) {
      if (!attributed.has(pid)) {
        attributed.add(pid);
        queue.push(pid);
      }
    }
  }
  return attributed;
}

/**
 * Usage of the pids `pids` between two samples. `cpuPct` is null without a previous
 * snapshot (or a zero/negative interval); `memPct` is against `usableMemBytes` (the
 * container-aware figure, so it answers "of what the board can use").
 */
export function usageFor(
  prev: MachineSample | null,
  next: MachineSample,
  pids: ReadonlySet<number>,
  usableMemBytes: number | null,
): UsageStats {
  const prevByPid = new Map<number, ProcInfo>();
  for (const proc of prev?.procs ?? []) prevByPid.set(proc.pid, proc);
  const elapsed = prev ? (next.at - prev.at) / 1000 : 0;
  let delta = 0;
  let memBytes = 0;
  for (const pid of pids) {
    const proc = next.procs.find((p) => p.pid === pid);
    if (!proc) continue;
    const before = prevByPid.get(pid);
    if (before && elapsed > 0) delta += Math.max(0, proc.ticks - before.ticks);
    memBytes += proc.rss ?? 0;
  }
  const cpuPct =
    elapsed > 0 && next.cpuCount > 0
      ? Math.min(100 * next.cpuCount, Math.max(0, (delta / (elapsed * CLK_TCK * next.cpuCount)) * 100))
      : null;
  const memPct = usableMemBytes && usableMemBytes > 0 ? (memBytes / usableMemBytes) * 100 : null;
  return { cpuPct, memBytes, memPct, processes: pids.size };
}

/** Whole-machine deltas: CPU% busy and memory used (MemTotal - MemAvailable). */
export function machineUsage(prev: MachineSample | null, next: MachineSample): MachineUsage {
  const elapsed = prev ? (next.at - prev.at) / 1000 : 0;
  const cpuPct =
    prev?.cpuTicks && next.cpuTicks && elapsed > 0
      ? Math.min(
          100,
          Math.max(
            0,
            ((next.cpuTicks.total - prev.cpuTicks.total - (next.cpuTicks.idle - prev.cpuTicks.idle)) /
              (next.cpuTicks.total - prev.cpuTicks.total)) *
              100,
          ),
        )
      : null;
  const memUsedBytes =
    next.memTotalBytes !== null && next.memAvailableBytes !== null
      ? Math.max(0, next.memTotalBytes - next.memAvailableBytes)
      : null;
  const memPct =
    memUsedBytes !== null && next.memTotalBytes && next.memTotalBytes > 0
      ? (memUsedBytes / next.memTotalBytes) * 100
      : null;
  return { cpuPct, memUsedBytes, memTotalBytes: next.memTotalBytes, memPct, cpus: next.cpuCount };
}

/**
 * Fold two snapshots into the report shape `GET /api/usage` answers. `roots` maps an
 * operation's lane worktrees (realpath'ed); `allRoots` is every open operation's union.
 * Null `roots` means "no operation selected".
 */
export function buildUsage(
  prev: MachineSample | null,
  next: MachineSample,
  roots: readonly string[] | null,
  allRoots: readonly string[],
  usableMemBytes: number | null,
): UsageReport {
  return {
    op: roots === null ? null : usageFor(prev, next, attributeProcesses(next.procs, roots), usableMemBytes),
    all: usageFor(prev, next, attributeProcesses(next.procs, allRoots), usableMemBytes),
    machine: machineUsage(prev, next),
  };
}
