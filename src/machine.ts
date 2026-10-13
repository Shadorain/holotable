import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import type { CpuTicks, MachineSample, ProcInfo } from "./core/usage.ts";

/**
 * Memory the board's omp sessions can actually use, in bytes. In a container `os.totalmem()`
 * reports the host; the container's view is `/proc/meminfo` (lxcfs) or the cgroup limit, so the
 * smallest known figure wins.
 */
export function usableMemoryBytes(): number {
  const figures = [totalmem()];
  try {
    const kb = /^MemTotal:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
    if (kb) figures.push(Number(kb) * 1024);
  } catch {
    // not Linux
  }
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      // cgroup v1 reports "no limit" as a huge sentinel; anything above physical memory is not a limit.
      if (/^\d+$/.test(raw)) figures.push(Number(raw));
    } catch {
      // no such controller
    }
  }
  return Math.min(...figures);
}

export function availableMemoryBytes(procRoot = "/proc"): number | null {
  return memInfo(procRoot).memAvailableBytes;
}

/**
 * One /proc snapshot: machine CPU jiffies, meminfo totals and the process table
 * (pid, ppid, cwd, utime+stime, RSS). Everything degrades to null — never throws —
 * so a non-Linux host or a mid-scan exit just yields less data.
 * `procRoot` exists for tests; production callers leave it at /proc.
 */
export function sampleMachine(procRoot = "/proc"): MachineSample {
  return {
    at: Date.now(),
    cpuTicks: machineTicks(procRoot),
    ...memInfo(procRoot),
    cpuCount: cpuCount(procRoot),
    procs: processTable(procRoot),
  };
}

/** Page size for statm. getconf is a spawn, and x86_64/arm64 boards run 4 KiB pages. */
const PAGE_BYTES = 4096;

function machineTicks(procRoot: string): CpuTicks | null {
  try {
    const line = readFileSync(join(procRoot, "stat"), "utf8").split("\n", 1)[0];
    const fields = line?.trim().split(/\s+/) ?? [];
    if (fields[0] !== "cpu") return null;
    // user nice system idle iowait irq softirq steal guest guest_nice;
    // the guest jiffies are already counted inside user/nice, so they stay out.
    const nums = fields.slice(1).map(Number);
    if (nums.length < 8 || nums.some((n) => !Number.isFinite(n))) return null;
    const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
    const total = nums[0]! + nums[1]! + nums[2]! + idle + nums[5]! + nums[6]! + nums[7]!;
    return { total, idle };
  } catch {
    return null;
  }
}

function memInfo(procRoot: string): { memTotalBytes: number | null; memAvailableBytes: number | null } {
  try {
    const text = readFileSync(join(procRoot, "meminfo"), "utf8");
    const kb = (key: string) => {
      const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text)?.[1];
      return match ? Number(match) * 1024 : null;
    };
    return { memTotalBytes: kb("MemTotal"), memAvailableBytes: kb("MemAvailable") };
  } catch {
    return { memTotalBytes: null, memAvailableBytes: null };
  }
}

function cpuCount(procRoot: string): number {
  try {
    return Math.max(
      1,
      (readFileSync(join(procRoot, "stat"), "utf8").match(/^cpu\d+/gm) ?? []).length,
    );
  } catch {
    // Not Linux (or /proc unreadable): os.cpus() still knows the core count.
    return Math.max(1, cpus().length);
  }
}

/** /proc/<pid>/stat fields after the comm name: state ppid … utime(11) stime(12) */
function procStat(text: string): { ppid: number; ticks: number } | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  return Number.isFinite(ppid) && Number.isFinite(utime) && Number.isFinite(stime)
    ? { ppid, ticks: utime + stime }
    : null;
}

function procRss(text: string): number | null {
  const resident = Number(text.trim().split(/\s+/)[1]);
  return Number.isFinite(resident) ? resident * PAGE_BYTES : null;
}

function processTable(procRoot: string): ProcInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  const procs: ProcInfo[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const dir = join(procRoot, entry);
    let stat: { ppid: number; ticks: number } | null;
    let rss: number | null = null;
    try {
      stat = procStat(readFileSync(join(dir, "stat"), "utf8"));
    } catch {
      stat = null; // exited between readdir and read
    }
    if (!stat) continue;
    try {
      rss = procRss(readFileSync(join(dir, "statm"), "utf8"));
    } catch {
      rss = null;
    }
    let cwd: string | null = null;
    try {
      cwd = readlinkSync(join(dir, "cwd"));
    } catch {
      cwd = null; // kernel threads and short-lived processes have none to read
    }
    procs.push({ pid, ppid: stat.ppid, cwd, ticks: stat.ticks, rss });
  }
  return procs;
}
