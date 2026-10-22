import type { Contact, Measurements, UsageTotals } from "../types.ts";
import type { AgeSummary, Distribution } from "./types.ts";

export const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export const MEASUREMENT_COUNTS = ["recordedPassed", "recordedFailed", "repeatedFailedRevision", "mergePreflightFailures", "boundaryFailures", "reviewFailures", "acceptedRepairs", "completedRounds", "invalidatedRounds", "findingOccurrences", "latestActionable", "latestRejected", "workerAttempts", "workerBeads", "repairRound", "repairLinks"] as const;
/** Producer counters that only grow within a run; the rest describe the latest round. */
export const HISTORICAL_COUNTS = ["recordedPassed", "recordedFailed", "repeatedFailedRevision", "mergePreflightFailures", "boundaryFailures", "reviewFailures", "acceptedRepairs", "completedRounds", "invalidatedRounds", "findingOccurrences"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const MS_PER_HOUR = 3_600_000;

export const isNonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const isCount = (value: unknown): value is number => isNonnegative(value) && Number.isSafeInteger(value);
export const isTimestamp = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));

export const emptyTokens = (): UsageTotals["tokens"] => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const emptySeverity = (): Measurements["severity"] => ({ critical: 0, high: 0, medium: 0, low: 0 });
export const sumTokens = (tokens: UsageTotals["tokens"]): number => TOKEN_KEYS.reduce((total, key) => total + tokens[key], 0);

/** The phase decision-pane spend is attributed to. */
export const DECISION_PHASE = "decision";

/** Only implement/audit/closer contacts deliver work; decisions and conflict fixes do not count toward delivery. */
export const isWork = (contact: Pick<Contact, "kind">): boolean => contact.kind === "implement" || contact.kind === "audit" || contact.kind === "closer";

/** Median and nearest-rank p90; sorts `values` in place. */
export function distribution(values: number[]): Distribution {
  values.sort((a, b) => a - b);
  const n = values.length;
  if (!n) return { n, medianMs: null, p90Ms: null };
  const medianMs = n % 2 ? values[(n - 1) / 2]! : (values[n / 2 - 1]! + values[n / 2]!) / 2;
  return { n, medianMs, p90Ms: values[Math.ceil(n * .9) - 1]! };
}

export const emptyAge = (): AgeSummary => ({ n: 0, totalMs: 0, maxMs: null });
export function addAge(summary: AgeSummary, value: number): void {
  summary.n++;
  summary.totalMs += value;
  summary.maxMs = Math.max(summary.maxMs ?? 0, value);
}
