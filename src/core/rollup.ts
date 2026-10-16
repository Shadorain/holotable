import { HOLDS, type MeasurementConfig } from "./types.ts";
import type { Evaluation } from "./evaluation.ts";

/**
 * Cross-operation rollup over stored evaluations: ranked failure classes, wait
 * time, phase time, and configuration cohorts. Pure over Evaluation records -
 * open operations are folded by the service first; archives carry their frozen
 * evaluation. Counts are observations, not defect proof; shares rank, not cause.
 */
export interface RankedMetric {
  id: string;
  label: string;
  /** Raw magnitude: events for `events`, milliseconds for `ms`, USD for `usd`. */
  value: number;
  unit: "events" | "ms" | "usd";
  /** Sample denominator behind `rate`, when one exists (null = no denominator). */
  denominator: number | null;
  /** value / denominator when both are known and denominator > 0. */
  rate: number | null;
  /** Operations where this metric is nonzero. */
  operations: number;
}

export interface RollupCohort {
  key: string;
  operations: number;
  delivered: number;
  knownCostUsd: number | null;
  usagePartial: boolean;
  deliveryMedians: number[];
  phaseMs: Record<string, number>;
  failures: Record<string, number>;
  waitMs: number;
}

export interface IntelRollup {
  v: 1;
  generatedAt: number;
  sources: { open: number; archived: number; evaluated: number; missingEvaluation: number };
  totals: {
    delivered: number;
    knownCostUsd: number | null;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
    reviews: number;
    repairRounds: number;
    costPerDelivered: number | null;
    usagePartial: boolean;
    timed: number;
  };
  failures: RankedMetric[];
  waits: RankedMetric[];
  /** Phases ranked by attributed cost deltas (present only when producers reported usage). */
  costs: RankedMetric[];
  phases: RankedMetric[];
  cohorts: RollupCohort[];
  caveats: string[];
}

export interface RollupEntry {
  name: string;
  closedAt: string | null;
  source: "open" | "archive";
  evaluation: Evaluation | null;
}

const configKey = (config: { value: MeasurementConfig | null; mixed: boolean }): string => {
  if (config.mixed) return "mixed configuration";
  if (config.value === null) return "uninstrumented";
  const c = config.value;
  return `${c.graph} / ${c.frontend} / ${c.maxWorkers} workers / ${c.mode}`;
};

export function computeRollup(entries: RollupEntry[], now: number): IntelRollup {
  const failures = new Map<string, RankedMetric>();
  const waits = new Map<string, RankedMetric>();
  const phases = new Map<string, RankedMetric>();
  const costs = new Map<string, RankedMetric>();
  const cohorts = new Map<string, RollupCohort>();
  const totals = { delivered: 0, knownCostUsd: 0, costSeen: false, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tokenSeen: false, reviews: 0, repairRounds: 0, usagePartial: false, timed: 0 };
  const caveats: string[] = [];
  let missingEvaluation = 0;

  const rank = (map: Map<string, RankedMetric>, id: string, label: string, unit: RankedMetric["unit"], value: number | null | undefined, denominator: number | null): void => {
    if (value === null || value === undefined || value <= 0) return;
    const metric = map.get(id) ?? map.set(id, { id, label, value: 0, unit, denominator: null, rate: null, operations: 0 }).get(id)!;
    metric.value += value;
    if (denominator !== null) metric.denominator = (metric.denominator ?? 0) + denominator;
    metric.operations++;
  };

  const addCohort = (key: string, e: Evaluation): RollupCohort => {
    let cohort = cohorts.get(key);
    if (!cohort) {
      cohort = { key, operations: 0, delivered: 0, knownCostUsd: null, usagePartial: false, deliveryMedians: [], phaseMs: Object.create(null), failures: Object.create(null), waitMs: 0 };
      cohorts.set(key, cohort);
    }
    cohort.operations++;
    cohort.delivered += e.deliveredWork;
    if (e.usage.knownCostUsd !== null) cohort.knownCostUsd = (cohort.knownCostUsd ?? 0) + e.usage.knownCostUsd;
    cohort.usagePartial ||= e.usage.partial;
    if (e.delivery.medianMs !== null) cohort.deliveryMedians.push(e.delivery.medianMs);
    for (const [phase, ms] of Object.entries(e.phaseMs)) cohort.phaseMs[phase] = (cohort.phaseMs[phase] ?? 0) + ms;
    return cohort;
  };

  for (const entry of entries) {
    const e = entry.evaluation;
    if (!e) { missingEvaluation++; continue; }
    const work = e.coverage.timed;
    totals.delivered += e.deliveredWork;
    totals.timed += work;
    if (e.usage.knownCostUsd !== null) { totals.knownCostUsd += e.usage.knownCostUsd; totals.costSeen = true; }
    if (e.usage.tokens !== null) { for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) totals.tokens[k] += e.usage.tokens[k]; totals.tokenSeen = true; }
    totals.reviews += e.quality?.completedRounds ?? 0;
    totals.repairRounds += e.quality?.acceptedRepairs ?? 0;
    totals.usagePartial ||= e.usage.partial;

    const failuresOf: Array<[string, string, number, number | null]> = [
      ["launches", "Relaunches", e.attempts.relaunches, e.attempts.launches],
      ["launch-failures", "Launch failures", e.attempts.launchFailures, e.attempts.launches],
      ["conflicts", "Delivery conflicts", e.attempts.conflicts, e.attempts.landAttempts],
      ["recorded-failed", "Recorded check failures", e.quality?.recordedFailed ?? 0, null],
      ["repeated-revision", "Repeated failed revisions", e.quality?.repeatedFailedRevision ?? 0, e.quality?.recordedFailed ?? 0],
      ["review-failures", "Review round failures", e.quality?.reviewFailures ?? 0, e.quality ? e.quality.completedRounds + e.quality.reviewFailures : null],
      ["invalidated", "Invalidated review rounds", e.quality?.invalidatedRounds ?? 0, e.quality?.completedRounds ?? 0],
      ["merge-preflight", "Merge preflight failures", e.quality?.mergePreflightFailures ?? 0, null],
      ["boundary", "Boundary failures", e.quality?.boundaryFailures ?? 0, null],
      ["repairs", "Accepted repairs", e.quality?.acceptedRepairs ?? 0, null],
      ["actionable", "Actionable findings outstanding", e.quality?.latestActionable ?? 0, e.quality?.findingOccurrences ?? 0],
      ["rejected", "Rejected findings", e.quality?.latestRejected ?? 0, e.quality?.findingOccurrences ?? 0],
      ["resends", "Board resend requests", e.fleet.boardResendRequests, null],
      ["redispatches", "Worker redispatches", e.fleet.redispatches ?? 0, e.fleet.workerAttempts],
      ["repair-links", "Repair links opened", e.fleet.repairLinks ?? 0, null],
    ];
    const waitTotal = (e.dependencyWaitMs ?? 0) + (e.gateWaitMs ?? 0) + (e.offlineMs ?? 0) + (e.deliveryReadyMs ?? 0) + HOLDS.reduce((a, h) => a + (e.holdMs[h] ?? 0), 0);
    const cohort = addCohort(configKey(e.config), e);
    for (const [id, label, value, denominator] of failuresOf) {
      rank(failures, id, label, "events", value, denominator);
      if (value > 0) cohort.failures[id] = (cohort.failures[id] ?? 0) + value;
    }
    rank(waits, "dependency", "Dependency wait", "ms", e.dependencyWaitMs, waitTotal || null);
    rank(waits, "gate", "Gate wait", "ms", e.gateWaitMs, waitTotal || null);
    rank(waits, "offline", "Offline / unreachable", "ms", e.offlineMs, waitTotal || null);
    rank(waits, "ready", "Ready → land delay", "ms", e.deliveryReadyMs, waitTotal || null);
    for (const hold of HOLDS) rank(waits, `hold-${hold}`, `Hold: ${hold}`, "ms", e.holdMs[hold], waitTotal || null);
    const phaseTotal = Object.values(e.phaseMs).reduce((a, b) => a + b, 0);
    for (const [phase, ms] of Object.entries(e.phaseMs)) rank(phases, phase, `Phase: ${phase}`, "ms", ms, phaseTotal || null);
    if (e.usage.byPhase) {
      const costTotal = Object.values(e.usage.byPhase).reduce((a, v) => a + (v.costUsd ?? 0), 0);
      for (const [phase, v] of Object.entries(e.usage.byPhase)) {
        rank(costs, phase, `Phase: ${phase}`, "usd", v.costUsd ?? 0, costTotal > 0 ? costTotal : null);
      }
    }
    cohort.waitMs += waitTotal;
  }

  const finalize = (map: Map<string, RankedMetric>): RankedMetric[] => {
    const list = [...map.values()];
    for (const m of list) if (m.denominator !== null && m.denominator > 0) m.rate = m.value / m.denominator;
    list.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
    return list;
  };

  if (missingEvaluation) caveats.push(`${missingEvaluation} source${missingEvaluation === 1 ? "" : "s"} had no evaluation - older archives and operations without producer evidence are counted in coverage only.`);
  if (totals.usagePartial) caveats.push("Usage evidence is partial or associated with the coordinator session; cost figures are estimates, not bills.");
  if (totals.timed === 0) caveats.push("No timed contacts recorded; timing classes are absent, not zero.");
  caveats.push("Counts are recorded process evidence - repeated attempts and reviews are not proof of defects, and waits overlap; ranking is by magnitude, not causality.");

  return {
    v: 1, generatedAt: now,
    sources: { open: entries.filter(x => x.source === "open").length, archived: entries.filter(x => x.source === "archive").length, evaluated: entries.length - missingEvaluation, missingEvaluation },
    totals: {
      delivered: totals.delivered,
      knownCostUsd: totals.costSeen ? totals.knownCostUsd : null,
      tokens: totals.tokenSeen ? totals.tokens : null,
      reviews: totals.reviews, repairRounds: totals.repairRounds,
      costPerDelivered: totals.costSeen && totals.delivered > 0 ? totals.knownCostUsd / totals.delivered : null,
      usagePartial: totals.usagePartial, timed: totals.timed,
    },
    failures: finalize(failures), waits: finalize(waits), costs: finalize(costs), phases: finalize(phases),
    cohorts: [...cohorts.values()].sort((a, b) => b.operations - a.operations || a.key.localeCompare(b.key)),
    caveats,
  };
}
