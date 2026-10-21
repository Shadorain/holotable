import type { Contact, Hold, Kind, MeasurementConfig, Measurements, RecoveryDeferral, SampleFields, Span, UsageSource, UsageTotals } from "../types.ts";

/** A declared contact with its fold state accrued up to the evaluation clock. */
export interface Timeline { contact: Contact; state: ContactEvaluation }
export interface Distribution { n: number; medianMs: number | null; p90Ms: number | null }
export interface AgeSummary { n: number; totalMs: number; maxMs: number | null }
export interface Recommendation {
  id: string; ruleVersion: 1; level: "info" | "warning"; message: string;
  evidence: { numerator: number; denominator: number | null; observedMs: number | null; contacts: string[]; eventIndexes: number[] };
  caveat: string;
  /**
   * What the rule puts at stake: `ms` time and `usd` known spend (null when the rule measures neither);
   * `scoreMs` is the larger of `ms` and `usd` converted to time at the operation's own spend per active hour.
   * Recommendations are ordered by `scoreMs`. Absent on evaluations archived before impact ranking.
   */
  impact?: { ms: number | null; usd: number | null; scoreMs: number };
}
/**
 * Known spend split by what it bought; the USD parts sum to `knownCostUsd` (all null when no cost is known).
 * Landed/support/open/abandoned exclude board pane spend, which is `paneUsd` alone.
 */
export interface SpendEvaluation {
  /** Spend of landed implement/audit/closer contacts (sources and legacy totals, no panes). */
  landedUsd: number | null;
  /** Landed work contacts whose spend has a known cost; the `perLandedUsd` denominator. */
  landedPriced: number;
  /** `landedUsd / landedPriced`; null without a priced landed contact. */
  perLandedUsd: number | null;
  /** Landed conflict-helper and decision contacts (integration and decision support). */
  supportUsd: number | null;
  /** Unlanded contacts still open at the evaluation clock: not yet delivered, not yet wasted. */
  openUsd: number | null;
  /** Unlanded contacts that were reaped, removed or closed, plus sources first seen by contacts no longer declared. */
  abandonedUsd: number | null;
  /** Board-opened decision panes (all tickets, declared or not). */
  paneUsd: number | null;
  /** `abandonedUsd + paneUsd`. */
  wastedUsd: number | null;
  /** Share of launched contacts whose spend is fully known (priced, not partial, not missing); null with none launched. */
  knownShare: number | null;
  /** `pricedMessages / (pricedMessages + unpricedMessages)`; null when message counts are unknown or zero. */
  pricedShare: number | null;
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
  /** Absent on evaluations archived before the spend split. */
  spend?: SpendEvaluation;
}
/** Who ended an operator-wait interval: the operator (or nobody, before close), or automation (auto mode, recovery, a decision agent). */
export type WaitActor = "operator" | "automation";
/** Fold-side wait kinds; `ready` (queued, unblocked, unlaunched) reports as `launch`, or `decision` for decision contacts. */
export type FoldWaitKind = "ready" | "plan-approval" | "gate" | "question" | "resume" | "land";
export type WaitKind = Exclude<FoldWaitKind, "ready"> | "launch" | "decision";
export interface WaitTotals {
  /** Closed waits the operator resolved, or that no one resolved before the contact ended. */
  operatorMs: number;
  /** Closed waits auto mode, recovery or a decision agent resolved. */
  automationMs: number;
  /** Waits still open at the evaluation clock (0 once the operation closes). */
  pendingMs: number;
  /** Wait intervals entered, open ones included. */
  waits: number;
}
export interface OperatorWaitEvaluation extends WaitTotals {
  /** Launched, live contact time outside any wait: time the mission itself owned the work. */
  missionMs: number;
  byKind: Partial<Record<WaitKind, WaitTotals>>;
}
/** One producer-observed increase in completed review rounds; `rounds` > 1 when samples skipped rounds. */
export interface ReviewRound { at: number; rounds: number; findings: number; actionable: number; rejected: number }
export type ContactFinalState = "unqueued" | "queued" | "blocked" | "running" | "hold" | "offline" | "complete" | "landed" | "reaped" | "removed" | "closed";
/** One declared contact at the evaluation clock. Times are epoch ms; durations ms. */
export interface ContactReport {
  ticket: string; kind: Kind; state: ContactFinalState; outcome: "landed" | "abandoned" | "open";
  phase: string | null; hold: Hold | null;
  queuedAt: number | null; launchedAt: number | null; landedAt: number | null; endedAt: number | null;
  /** Queued → landed. */
  leadMs: number | null;
  /** Launched and live (not reaped, landed or closed). */
  activeMs: number;
  /** `beforeLaunch` matches dependencyWaitMs; `afterLaunch` counts blocks that began after launch; `by` credits every listed blocker (overlapping). */
  blockedMs: { beforeLaunch: number; afterLaunch: number; by: Record<string, number> };
  phaseMs: Record<string, number>;
  offlineMs: number;
  waitMs: { operator: number; automation: number; pending: number };
  /** Null without producer measurements for the contact; `perRound` keeps the latest 10 increases. */
  review: { rounds: number; findings: number; failures: number; perRound: ReviewRound[] } | null;
  /** `total` is launches − 1; `other` covers relaunches with no attributable launch action (lander, older history). */
  relaunches: { total: number; operator: number; recovery: number; auto: number; other: number };
  launchFailures: number;
  /** `paths` are the latest 10 distinct conflicting paths. */
  conflicts: { count: number; landAttempts: number; paths: string[] };
  /** Contact-attributed tokens and USD (sources it first observed, legacy totals, its panes); `complete` when fully priced. */
  spend: { tokens: number | null; costUsd: number | null; complete: boolean };
}
export interface SeriesBucket { at: number; launches: number; deliveries: number; landAttempts: number; conflicts: number; reviewFailures: number }
/** Dense UTC epoch-aligned buckets from operation creation to the clock; `truncated` drops the oldest beyond 168. */
export interface SeriesEvaluation { bucketMs: number; truncated: boolean; buckets: SeriesBucket[] }
/** Mission stall classes: the recorded `problem` kind, or the quota hold when a sample carries no problem. */
export type StallKind = "quota" | "rateLimit" | "otherProblem";
export interface StallTotals { ms: number; episodes: number }
export interface StallEvaluation {
  /** Problem kind `quota`, or mission hold `quota` while samples carry no problem (older logs fold rate limits in). */
  quota: StallTotals;
  /** Problem kind `rate-limit`. The optional fields below are absent on evaluations archived before they existed. */
  rateLimit?: StallTotals;
  /** Problem kinds `timeout` and `error`. */
  otherProblem?: StallTotals;
  /** Socket-down intervals. */
  offline: StallTotals;
  /** Auto mode waiting for provider capacity (`capacity-wait` events). */
  capacityWait?: StallTotals;
  /** Recovery deferring a relaunch (`recovery-wait` events); `byKind` splits `ms` by reason. */
  recoveryDeferral?: StallTotals & { byKind: Record<RecoveryDeferral, number> };
  /** Failed launch/relaunch actions by recorded error class (counts; their wait time is not recorded). */
  launchRefusals: { memory: number; sessionCap: number; refused: number; gaveUp: number };
  /** Producer review failures (null without measurements); may include provider-capacity failures. */
  reviewFailures: number | null;
  caveat: string;
}
export interface ConflictEvaluation {
  /** conflicts / landAttempts; null without land attempts. */
  rate: number | null;
  /** Conflicting land attempts that recorded no paths. */
  unpathed: number;
  /** Top 10 paths by conflicting attempts, with up to 3 latest contacts. */
  paths: Array<{ path: string; conflicts: number; contacts: string[] }>;
  /** Top 5 contacts by conflicts. */
  contacts: Array<{ ticket: string; conflicts: number; landAttempts: number }>;
  /** More distinct paths conflicted than the fold tracks; `paths` may miss some. */
  truncated: boolean;
}
export interface ActivityEvaluation {
  /** Time at least one declared contact was queued or live. */
  activeMs: number;
  /** Elapsed operation time with nothing queued or live. */
  idleMs: number;
  deliveriesPerActiveHour: number | null;
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
  /** The fields below are absent on evaluations archived before they existed. */
  contacts?: ContactReport[];
  operatorWait?: OperatorWaitEvaluation;
  activity?: ActivityEvaluation;
  series?: SeriesEvaluation;
  stalls?: StallEvaluation;
  conflicts?: ConflictEvaluation;
}
export interface WaitAccount { operatorMs: number; automationMs: number; waits: number }
export interface LaunchRefusals { memory: number; sessionCap: number; refused: number; gaveUp: number }
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
  /** Launched-live time, and the part of it outside any operator wait. */
  liveMs: number; ownMs: number;
  /** `blockedPost`: the current block began after launch. `blockedByMs` credits every current blocker. */
  blockedAfterMs: number; blockedPost: boolean; blockedBy: string[]; blockedByMs: Record<string, number>;
  endedBy: "reaped" | "removed" | "closed" | null;
  relaunchBy: { operator: number; recovery: number; auto: number };
  refusals: LaunchRefusals;
  conflictPaths: string[]; offlineEpisodes: number;
  /** The current stall class and Recovery deferral, with time and entries per class. */
  stall: StallKind | null; stallMs: Record<StallKind, number>; stallEpisodes: Record<StallKind, number>;
  deferral: RecoveryDeferral | null; deferralMs: Record<RecoveryDeferral, number>; deferralEpisodes: number;
  /** The open wait, when it began and its accrued ms; settled totals per kind. */
  wait: FoldWaitKind | null; waitFrom: number; waitMs: number; waits: Partial<Record<FoldWaitKind, WaitAccount>>;
  /** A closed wait whose resolving action is recorded just after it (land, launch); settles to the operator otherwise. */
  unsettled: { kind: FoldWaitKind; ms: number; at: number } | null;
  /** The latest successful action that resolves waits of `kinds`. */
  resolved: { kinds: readonly FoldWaitKind[]; actor: WaitActor; at: number } | null;
  rounds: ReviewRound[];
  /** Intervals the contact was queued or live, for operation active time. */
  busySpans: Span[];
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
  /** Hour index (epoch ms / 3.6e6) → counts; review failures are producer counter increases at sample time. */
  series: Map<number, { launches: number; landAttempts: number; conflicts: number; reviewFailures: number }>;
  conflictPaths: Map<string, { conflicts: number; contacts: string[] }>; unpathedConflicts: number; droppedPaths: number;
  /** Auto mode's capacity wait: open since `from` (null when not waiting), closed time and entries. */
  capacity: { from: number | null; ms: number; episodes: number };
  /** `role:id` source → the ticket that first observed it (owns its spend). */
  sourceOwners: Map<string, string>;
}
