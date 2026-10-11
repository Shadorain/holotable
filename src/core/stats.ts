import type { Derived, Stats } from "./types.ts";

/** All stats derive from events; fields with no data are omitted, not zeroed. */
export function computeStats(
  derived: Derived,
  now: number,
  current: number,
): Stats {
  const duration = (from: number, to: number | null): number => (to ?? now) - from;

  const queueWaitMs: Record<string, number> = {};
  for (const [ticket, d] of Object.entries(derived.contacts)) {
    if (d.queuedAt === null) continue;
    // Contacts that land without launching (decisions, marked done) stop waiting.
    queueWaitMs[ticket] = duration(d.queuedAt, d.launchedAt ?? d.landedAt);
  }

  const phaseMs: Record<string, number> = {};
  let gateWait = 0;
  let hasGateWait = false;
  let socketDown = 0;
  let hasSocketDown = false;
  let landAttempts = 0;
  let conflicts = 0;
  for (const d of Object.values(derived.contacts)) {
    for (const s of d.phaseSpans) {
      phaseMs[s.phase] = (phaseMs[s.phase] ?? 0) + duration(s.from, s.to);
    }
    for (const s of d.gateSpans) {
      gateWait += duration(s.from, s.to);
      hasGateWait = true;
    }
    for (const s of d.downSpans) {
      socketDown += duration(s.from, s.to);
      hasSocketDown = true;
    }
    landAttempts += d.landAttempts;
    conflicts += d.conflicts;
  }
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let hasUsage = false;
  let costUsd = 0;
  let hasCost = false;
  for (const d of Object.values(derived.contacts)) {
    const usage = d.lastSample?.usage;
    if (!usage) continue;
    hasUsage = true;
    tokens.input += usage.tokens.input;
    tokens.output += usage.tokens.output;
    tokens.cacheRead += usage.tokens.cacheRead;
    tokens.cacheWrite += usage.tokens.cacheWrite;
    if (usage.costUsd !== null) {
      costUsd += usage.costUsd;
      hasCost = true;
    }
  }
  const waits = Object.values(queueWaitMs);
  const stats: Stats = {
    queueWaitMs,
    phaseMs,
    landAttempts,
    conflicts,
    omp: { current, peak: Math.max(derived.peakOmp, current) },
  };
  if (waits.length > 0) stats.queueWaitAvgMs = waits.reduce((a, b) => a + b, 0) / waits.length;
  if (hasGateWait) stats.gateWaitMs = gateWait;
  if (hasSocketDown) stats.socketDownMs = socketDown;
  if (landAttempts > 0) stats.conflictRate = conflicts / landAttempts;
  if (hasUsage) stats.tokens = tokens;
  if (hasCost) stats.costUsd = costUsd;
  return stats;
}
