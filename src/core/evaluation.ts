/**
 * Operation evaluation (the Intel payload). Events fold incrementally into per-contact state
 * (`evaluation/fold.ts`, carried on `derived.evaluation`); `evaluateOperation` projects that state
 * at a clock into metric families:
 *
 * - delivery & throughput — deliveredWork, throughputPerHour, queue/delivery/lead, queued/unfinished ages,
 *   deliveryReadyMs → `evaluateDelivery` (evaluation/metrics.ts)
 * - time & blocking — phaseMs, holdMs, gateWaitMs, dependencyWaitMs, offlineMs, connectivity, workers,
 *   coverage.timed/launched → `evaluateTime`
 * - attempts & conflicts — launches, relaunches, launch failures, land attempts, conflicts, board resends
 *   → `evaluateAttempts`
 * - spend & usage — tokens, cost, byPhase, pane, cost per delivered, accounting gaps → `evaluateUsage`
 * - rework & review — quality counters and fleet dispatch from producer measurements → `evaluateQuality`
 * - per contact, operator wait, spend split — contacts, operatorWait, usage.spend → `evaluateContacts`
 *   (evaluation/contacts.ts)
 * - trends — activity (active-hour throughput), series, stalls, conflict detail → evaluation/trends.ts
 * - recommendations — threshold rules over the above, ranked by stake, with cited events → evaluation/recommend.ts
 *
 * Distribution and age helpers live in evaluation/shared.ts; payload validation in evaluation/parse.ts.
 */
export type {
  ActivityEvaluation, AgeSummary, ConflictEvaluation, ContactEvaluation, ContactReport, Distribution, Evaluation,
  EvaluationEvidence, FoldEvaluation, OperatorWaitEvaluation, QualityEvaluation, Recommendation, SeriesEvaluation,
  SpendEvaluation, StallEvaluation, UsageEvaluation, WaitKind,
} from "./evaluation/types.ts";
export { MEASUREMENT_COUNTS, distribution } from "./evaluation/shared.ts";
export { parseEvaluation, parseMeasurementConfig, parseMeasurements, parseUsageEvidence } from "./evaluation/parse.ts";
export { createFoldEvaluation, foldEvaluation } from "./evaluation/fold.ts";
export { evaluateOperation } from "./evaluation/metrics.ts";
export { evaluationEvidence, recommendEvaluation } from "./evaluation/recommend.ts";
