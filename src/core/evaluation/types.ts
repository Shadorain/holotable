import type { Hold, MeasurementConfig, Measurements, SampleFields, UsageSource, UsageTotals } from "../types.ts";

export interface Distribution { n: number; medianMs: number | null; p90Ms: number | null }
export interface AgeSummary { n: number; totalMs: number; maxMs: number | null }
export interface Recommendation {
  id: string; ruleVersion: 1; level: "info" | "warning"; message: string;
  evidence: { numerator: number; denominator: number | null; observedMs: number | null; contacts: string[]; eventIndexes: number[] };
  caveat: string;
}
export interface UsageEvaluation {
  basis: "legacy" | "scoped" | "mixed" | "missing";
  tokens: UsageTotals["tokens"] | null; knownCostUsd: number | null; costPerDelivered: number | null;
  missingSources: number; unsupportedWorkers: number; pricedMessages: number | null; unpricedMessages: number | null;
  malformedLines: number; resets: number; backlogBytes: number; coordinatorSessionAssociated: boolean; partial: boolean;
  /** Token deltas attributed to the contact's phase at sample time; phase keys absent without data. */
  byPhase?: Record<string, { tokens: number; costUsd: number | null }>;
  /** Agent panes the board itself opened (decision panes); absent on evaluations older than pane accounting. */
  pane?: { tokens: number; costUsd: number | null; sessions: number } | null;
}
export interface QualityEvaluation {
  since: string; recordedPassed: number; recordedFailed: number; repeatedFailedRevision: number;
  mergePreflightFailures: number; boundaryFailures: number; reviewFailures: number; acceptedRepairs: number;
  completedRounds: number; invalidatedRounds: number; findingOccurrences: number;
  latestActionable: number; latestRejected: number; severity: Measurements["severity"];
}
export interface Evaluation {
  v: 1; asOf: number; deliveredWork: number; throughputPerHour: number | null;
  queue: Distribution; queued: AgeSummary; delivery: Distribution; lead: Distribution; unfinished: AgeSummary;
  dependencyWaitMs: number | null; phaseMs: Record<string, number>; gateWaitMs: number | null; offlineMs: number | null;
  deliveryReadyMs: number | null; holdMs: Partial<Record<Hold, number>>;
  connectivity: { observedMs: number; connectedContactMs: number; peak: number; mean: number | null };
  workers: { coveredMs: number; nonclosedWorkerMs: number };
  attempts: { launches: number; relaunches: number; launchFailures: number; landAttempts: number; conflicts: number };
  fleet: { workerAttempts: number | null; workerBeads: number | null; redispatches: number | null; repairRound: number | null; repairLinks: number | null; boardResendRequests: number };
  usage: UsageEvaluation; quality: QualityEvaluation | null;
  config: { value: MeasurementConfig | null; mixed: boolean };
  coverage: { timed: number; launched: number; usageReported: number; legacyUsage: number; producerEvidence: number; clockAnomalies: number; counterResets: number };
  recommendations: Recommendation[];
}
/** Per-contact fold state: timestamps, the current interval's attributes, and the time accrued under each. */
export interface ContactEvaluation {
  queued: number | null; launched: number | null; landed: number | null; ended: number | null;
  at: number; active: boolean; phase: string | null; gate: string | null; hold: Hold | null;
  blocked: boolean | null; socket: boolean; offline: boolean; workerValue: number | null;
  phaseMs: Record<string, number>; gateMs: number | null; offlineMs: number | null; blockedMs: number | null;
  holdMs: Partial<Record<Hold, number>>; workerMs: number; coveredMs: number; completeAt: number | null;
  launches: number; launchFailures: number; landAttempts: number; conflicts: number; resends: number;
  mission: string | null; latestRun: string | null; unknown: boolean; scoped: boolean;
  missing: number; unsupported: number; malformed: number; resets: number; backlog: number; partial: boolean;
  gateRefs: number[]; readyRefs: number[]; launchRefs: number[]; blockedRefs: number[]; usageRef: number | null; legacy: SampleFields["usage"] | null;
  legacyTotals: UsageTotals["tokens"] | null; legacyCostUsd: number | null;
  phaseTokens: Record<string, number>; phaseCostUsd: Record<string, number>;
  /** Pane totals already emitted to history; the watcher reads them to emit only the delta since last record. */
  paneIds: string[]; paneTokens: number; paneCostUsd: number | null; paneSessions: number;
  paneEmittedTokens: UsageTotals["tokens"]; paneEmittedCostUsd: number; paneMalformed: number; paneTruncated: boolean; paneEvents: number;
}
export interface RunEvidence { contact: string; missionId: string; measurements: Measurements; eventIndexes: number[] }
export interface EventRef { contact: string; index: number }
export interface ContactEvidence {
  ticket: string; launches?: number; lifetimeMs: number | null; gateHoldMs: number | null; blockedMs: number | null; finalReadyMs: number | null;
  gateEventIndexes: number[]; blockedEventIndexes: number[]; deliveryEventIndexes: number[]; launchEventIndexes: number[];
}
export interface EvaluationEvidence {
  runs: RunEvidence[];
  contacts: ContactEvidence[];
  conflictEvents: EventRef[];
  usageEvents: EventRef[];
}
/** Whole-operation fold state; `derived.evaluation` carries it between events. */
export interface FoldEvaluation {
  clock: number | null; closed: number | null; anomalies: number; resets: number;
  contacts: Record<string, ContactEvaluation>; runs: Map<string, RunEvidence>; sources: Map<string, UsageSource>;
  connected: number; peak: number; connectedMs: number; connectivityFrom: number | null;
  config: { value: MeasurementConfig | null; mixed: boolean };
  conflicts: EventRef[];
}
