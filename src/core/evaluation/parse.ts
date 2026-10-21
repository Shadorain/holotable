import { MODES, type MeasurementConfig, type Measurements, type UsageEvidence, type UsageSource } from "../types.ts";
import { isRecord } from "../validate.ts";
import { HISTORICAL_COUNTS, isCount, isNonnegative, isTimestamp, MEASUREMENT_COUNTS, SEVERITIES, TOKEN_KEYS } from "./shared.ts";
import type { Evaluation } from "./types.ts";

const MAX_WORKERS = 64;
const MAX_USAGE_SOURCES = 3;
const MAX_SOURCE_ID = 128;
const MAX_RECOMMENDATIONS = 6;
const MAX_EVIDENCE_ROWS = 3;

export function parseMeasurementConfig(value: unknown): MeasurementConfig | null {
  if (!isRecord(value)) return null;
  if (typeof value.graph !== "string" || !["local", "beads"].includes(value.graph)) return null;
  if (typeof value.frontend !== "string" || !["none", "orca", "herdr", "custom", "subagent"].includes(value.frontend)) return null;
  if (!isCount(value.maxWorkers) || value.maxWorkers < 1 || value.maxWorkers > MAX_WORKERS) return null;
  if (!isCount(value.reviewConcurrency) || value.reviewConcurrency < 1 || value.reviewConcurrency > MAX_WORKERS) return null;
  if (!MODES.includes(value.mode as never)) return null;
  return {
    graph: value.graph as MeasurementConfig["graph"],
    frontend: value.frontend as MeasurementConfig["frontend"],
    maxWorkers: value.maxWorkers,
    reviewConcurrency: value.reviewConcurrency,
    mode: value.mode as MeasurementConfig["mode"],
  };
}

export function parseMeasurements(value: unknown): Measurements | null {
  if (!isRecord(value) || value.v !== 1 || !isTimestamp(value.since) || !isRecord(value.severity)) return null;
  const severity = value.severity;
  if (!MEASUREMENT_COUNTS.every(key => isCount(value[key])) || !SEVERITIES.every(key => isCount(severity[key]))) return null;
  const config = parseMeasurementConfig(value.config);
  if (!config) return null;
  const result = { v: 1, since: value.since, severity: { critical: severity.critical, high: severity.high, medium: severity.medium, low: severity.low }, config } as Measurements;
  for (const key of MEASUREMENT_COUNTS) result[key] = value[key] as number;
  return result;
}

function parseUsageSource(raw: unknown): UsageSource | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.role !== "string" || !["coordinator", "worker", "review"].includes(raw.role)) return null;
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > MAX_SOURCE_ID) return null;
  const tokens = raw.tokens;
  if (!isRecord(tokens) || !TOKEN_KEYS.every(key => isCount(tokens[key]))) return null;
  if (!(raw.costUsd === null || isNonnegative(raw.costUsd))) return null;
  if (!["sessions", "pricedMessages", "unpricedMessages"].every(key => isCount(raw[key]))) return null;
  return {
    role: raw.role as UsageSource["role"], id: raw.id,
    tokens: { input: tokens.input as number, output: tokens.output as number, cacheRead: tokens.cacheRead as number, cacheWrite: tokens.cacheWrite as number },
    costUsd: raw.costUsd as number | null, sessions: raw.sessions as number,
    pricedMessages: raw.pricedMessages as number, unpricedMessages: raw.unpricedMessages as number,
  };
}

export function parseUsageEvidence(value: unknown): UsageEvidence | null {
  if (!isRecord(value) || value.v !== 1 || !isTimestamp(value.measuredAt) || typeof value.partial !== "boolean") return null;
  if (!Array.isArray(value.sources) || value.sources.length > MAX_USAGE_SOURCES) return null;
  if (!["missing", "unsupportedWorkers", "malformedLines", "resets", "backlogBytes"].every(key => isCount(value[key]))) return null;
  const sources: UsageSource[] = [];
  const roles = new Set<string>();
  for (const raw of value.sources) {
    const source = parseUsageSource(raw);
    // One source per role: a duplicate role would double-count that role's spend.
    if (!source || roles.has(source.role)) return null;
    roles.add(source.role);
    sources.push(source);
  }
  return {
    v: 1, measuredAt: value.measuredAt, sources,
    missing: value.missing as number, unsupportedWorkers: value.unsupportedWorkers as number, malformedLines: value.malformedLines as number,
    resets: value.resets as number, backlogBytes: value.backlogBytes as number, partial: value.partial,
  };
}

const isNullableNumber = (value: unknown) => value === null || isNonnegative(value);
const fieldsAre = (value: unknown, fields: readonly string[], check: (field: unknown) => boolean) =>
  isRecord(value) && fields.every(field => check(value[field]));

const REQUIRED_COUNTS: Record<string, string[]> = {
  attempts: ["launches", "relaunches", "launchFailures", "landAttempts", "conflicts"],
  coverage: ["timed", "launched", "usageReported", "legacyUsage", "producerEvidence", "clockAnomalies", "counterResets"],
  workers: ["coveredMs", "nonclosedWorkerMs"],
};

function isUsageEvaluation(usage: unknown): boolean {
  if (!isRecord(usage)) return false;
  if (typeof usage.basis !== "string" || !["legacy", "scoped", "mixed", "missing"].includes(usage.basis)) return false;
  if (typeof usage.partial !== "boolean" || typeof usage.coordinatorSessionAssociated !== "boolean") return false;
  if (!fieldsAre(usage, ["knownCostUsd", "costPerDelivered", "pricedMessages", "unpricedMessages"], isNullableNumber)) return false;
  if (!fieldsAre(usage, ["missingSources", "unsupportedWorkers", "malformedLines", "resets", "backlogBytes"], isCount)) return false;
  if (!(usage.tokens === null || fieldsAre(usage.tokens, TOKEN_KEYS, isNonnegative))) return false;
  if (usage.byPhase !== undefined && (!isRecord(usage.byPhase) || !Object.values(usage.byPhase).every(row => isRecord(row) && isNonnegative(row.tokens) && isNullableNumber(row.costUsd)))) return false;
  const pane = usage.pane;
  if (pane !== undefined && pane !== null && (!isRecord(pane) || !isNonnegative(pane.tokens) || !isNullableNumber(pane.costUsd) || !isNonnegative(pane.sessions))) return false;
  return true;
}

function isRecommendation(value: unknown): boolean {
  if (!isRecord(value) || value.ruleVersion !== 1) return false;
  if (typeof value.id !== "string" || typeof value.message !== "string" || typeof value.caveat !== "string") return false;
  if (typeof value.level !== "string" || !["info", "warning"].includes(value.level)) return false;
  const evidence = value.evidence;
  if (!isRecord(evidence) || !isNonnegative(evidence.numerator) || !isNullableNumber(evidence.denominator) || !isNullableNumber(evidence.observedMs)) return false;
  const { contacts, eventIndexes } = evidence;
  if (!Array.isArray(contacts) || contacts.length > MAX_EVIDENCE_ROWS || !contacts.every((contact: unknown) => typeof contact === "string")) return false;
  return Array.isArray(eventIndexes) && eventIndexes.length <= MAX_EVIDENCE_ROWS && eventIndexes.every(isCount);
}

/** Validates a stored (archived) evaluation; null when any field is malformed. */
export function parseEvaluation(value: unknown): Evaluation | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (!fieldsAre(value, ["deliveredWork", "asOf"], isNonnegative)) return null;
  if (!fieldsAre(value, ["throughputPerHour", "dependencyWaitMs", "gateWaitMs", "offlineMs", "deliveryReadyMs"], isNullableNumber)) return null;
  for (const key of ["queue", "delivery", "lead"]) {
    const summary = value[key];
    if (!isRecord(summary) || !isCount(summary.n) || !isNullableNumber(summary.medianMs) || !isNullableNumber(summary.p90Ms)) return null;
  }
  for (const key of ["queued", "unfinished"]) {
    const summary = value[key];
    if (!isRecord(summary) || !isCount(summary.n) || !isNonnegative(summary.totalMs) || !isNullableNumber(summary.maxMs)) return null;
  }
  for (const key of ["phaseMs", "holdMs"]) if (!isRecord(value[key]) || !Object.values(value[key] as object).every(isNonnegative)) return null;
  for (const [key, fields] of Object.entries(REQUIRED_COUNTS)) if (!fieldsAre(value[key], fields, isNonnegative)) return null;
  if (!fieldsAre(value.connectivity, ["observedMs", "connectedContactMs", "peak"], isNonnegative) || !isNullableNumber((value.connectivity as Record<string, unknown>).mean)) return null;
  if (!fieldsAre(value.fleet, ["workerAttempts", "workerBeads", "redispatches", "repairRound", "repairLinks", "boardResendRequests"], isNullableNumber)) return null;
  if (!isUsageEvaluation(value.usage)) return null;
  if (!isRecord(value.config) || typeof value.config.mixed !== "boolean" || !(value.config.value === null || parseMeasurementConfig(value.config.value))) return null;
  const quality = value.quality;
  if (quality !== null && (!isRecord(quality) || !isTimestamp(quality.since) || !fieldsAre(quality, [...HISTORICAL_COUNTS, "latestActionable", "latestRejected"], isCount) || !fieldsAre(quality.severity, SEVERITIES, isCount))) return null;
  if (!Array.isArray(value.recommendations) || value.recommendations.length > MAX_RECOMMENDATIONS || !value.recommendations.every(isRecommendation)) return null;
  return value as unknown as Evaluation;
}
