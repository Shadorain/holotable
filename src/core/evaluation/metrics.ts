import { HOLDS, type Derived, type Operation } from "../types.ts";
import { evaluateContacts } from "./contacts.ts";
import { accrue, createFoldEvaluation } from "./fold.ts";
import { evaluationEvidence, recommendEvaluation } from "./recommend.ts";
import { addAge, DECISION_PHASE, distribution, emptyAge, emptySeverity, emptyTokens, HISTORICAL_COUNTS, isNonnegative, isWork, MS_PER_HOUR, SEVERITIES, TOKEN_KEYS } from "./shared.ts";
import { evaluateActivity, evaluateConflicts, evaluateSeries, evaluateStalls } from "./trends.ts";
import type { Evaluation, FoldEvaluation, Timeline, UsageEvaluation } from "./types.ts";

function emptyEvaluation(fold: FoldEvaluation, clock: number): Evaluation {
  return {
    v: 1, asOf: clock, deliveredWork: 0, throughputPerHour: null,
    queue: distribution([]), queued: emptyAge(), delivery: distribution([]), lead: distribution([]), unfinished: emptyAge(),
    dependencyWaitMs: null, phaseMs: Object.create(null), gateWaitMs: null, offlineMs: null, deliveryReadyMs: null, holdMs: {},
    connectivity: {
      observedMs: fold.connectivityFrom === null ? 0 : Math.max(0, clock - fold.connectivityFrom),
      connectedContactMs: fold.connectedMs + Math.max(0, clock - (fold.clock ?? clock)) * fold.connected,
      peak: fold.peak, mean: null,
    },
    workers: { coveredMs: 0, nonclosedWorkerMs: 0 },
    attempts: { launches: 0, relaunches: 0, launchFailures: 0, landAttempts: 0, conflicts: 0 },
    fleet: { workerAttempts: null, workerBeads: null, redispatches: null, repairRound: null, repairLinks: null, boardResendRequests: 0 },
    usage: { basis: "missing", tokens: null, knownCostUsd: null, costPerDelivered: null, missingSources: 0, unsupportedWorkers: 0, pricedMessages: 0, unpricedMessages: 0, malformedLines: 0, resets: 0, backlogBytes: 0, coordinatorSessionAssociated: false, partial: false },
    quality: null,
    config: { value: fold.config.value, mixed: fold.config.mixed },
    coverage: { timed: 0, launched: 0, usageReported: 0, legacyUsage: 0, producerEvidence: fold.runs.size, clockAnomalies: fold.anomalies, counterResets: fold.resets },
    recommendations: [],
  };
}

/** Delivered work, throughput, queue/delivery/lead distributions, unfinished ages and ready-to-land time. */
function evaluateDelivery(result: Evaluation, timelines: Timeline[], clock: number, elapsed: number): void {
  const queueMs: number[] = [], deliveryMs: number[] = [], leadMs: number[] = [];
  for (const { contact, state } of timelines) {
    if (!isWork(contact)) continue;
    const end = state.landed ?? state.ended ?? clock;
    if (state.queued !== null && state.launched !== null) queueMs.push(Math.max(0, state.launched - state.queued));
    else if (state.queued !== null && state.landed === null) addAge(result.queued, Math.max(0, end - state.queued));
    if (state.landed !== null) {
      result.deliveredWork++;
      if (state.launched !== null) deliveryMs.push(Math.max(0, state.landed - state.launched));
      if (state.queued !== null) leadMs.push(Math.max(0, state.landed - state.queued));
      if (state.completeAt !== null) result.deliveryReadyMs = (result.deliveryReadyMs ?? 0) + Math.max(0, state.landed - state.completeAt);
    } else if (state.launched !== null) addAge(result.unfinished, Math.max(0, end - state.launched));
  }
  result.queue = distribution(queueMs);
  result.delivery = distribution(deliveryMs);
  result.lead = distribution(leadMs);
  result.throughputPerHour = elapsed > 0 ? result.deliveredWork * MS_PER_HOUR / elapsed : null;
}

/** Where contact time went: phases, holds, gates, dependency blocking, offline, connectivity and worker occupancy. */
function evaluateTime(result: Evaluation, timelines: Timeline[]): void {
  for (const { state } of timelines) {
    if (state.launched !== null) result.coverage.launched++;
    if (state.queued !== null || state.launched !== null) result.coverage.timed++;
    for (const [phase, ms] of Object.entries(state.phaseMs)) result.phaseMs[phase] = (result.phaseMs[phase] ?? 0) + ms;
    for (const hold of HOLDS) if (state.holdMs[hold] !== undefined) result.holdMs[hold] = (result.holdMs[hold] ?? 0) + state.holdMs[hold]!;
    if (state.blockedMs !== null) result.dependencyWaitMs = (result.dependencyWaitMs ?? 0) + state.blockedMs;
    if (state.gateMs !== null) result.gateWaitMs = (result.gateWaitMs ?? 0) + state.gateMs;
    if (state.offlineMs !== null) result.offlineMs = (result.offlineMs ?? 0) + state.offlineMs;
    result.workers.coveredMs += state.coveredMs;
    result.workers.nonclosedWorkerMs += state.workerMs;
  }
  const { connectivity } = result;
  connectivity.mean = connectivity.observedMs ? connectivity.connectedContactMs / connectivity.observedMs : null;
}

/** Launches, relaunches, launch failures, land attempts, conflicts and board resends. */
function evaluateAttempts(result: Evaluation, timelines: Timeline[]): void {
  for (const { state } of timelines) {
    result.attempts.launches += state.launches;
    result.attempts.relaunches += Math.max(0, state.launches - 1);
    result.attempts.launchFailures += state.launchFailures;
    result.attempts.landAttempts += state.landAttempts;
    result.attempts.conflicts += state.conflicts;
    result.fleet.boardResendRequests += state.resends;
  }
}

function phaseRow(usage: UsageEvaluation, phase: string) {
  const byPhase = usage.byPhase ?? (usage.byPhase = Object.create(null) as NonNullable<UsageEvaluation["byPhase"]>);
  return byPhase[phase] ?? (byPhase[phase] = { tokens: 0, costUsd: null });
}

/**
 * Tokens and cost: scoped sources (deduped across contacts), legacy per-contact totals, and board-opened panes.
 * Additions run in contact → pane → source order; reordering changes floating-point cost totals.
 */
function evaluateUsage(result: Evaluation, timelines: Timeline[], fold: FoldEvaluation, declared: Operation["contacts"]): void {
  const { usage } = result;
  let scopedContacts = 0, legacyContacts = 0;
  for (const { state } of timelines) {
    usage.missingSources += state.missing;
    usage.unsupportedWorkers += state.unsupported;
    usage.byPhase ??= Object.create(null);
    for (const [phase, tokens] of Object.entries(state.phaseTokens)) phaseRow(usage, phase).tokens += tokens;
    for (const [phase, costUsd] of Object.entries(state.phaseCostUsd)) {
      const row = phaseRow(usage, phase);
      row.costUsd = (row.costUsd ?? 0) + costUsd;
    }
    if (!Object.keys(usage.byPhase!).length) usage.byPhase = undefined;
    usage.malformedLines += state.malformed;
    usage.resets += state.resets;
    usage.backlogBytes += state.backlog;
    usage.partial ||= state.partial || state.unknown;
    if (state.scoped) {
      scopedContacts++;
      result.coverage.usageReported++;
    } else if (state.legacy) {
      const legacy = state.legacy;
      legacyContacts++;
      result.coverage.usageReported++;
      if (TOKEN_KEYS.every(key => isNonnegative(legacy.tokens[key]))) {
        usage.tokens ??= emptyTokens();
        for (const key of TOKEN_KEYS) usage.tokens[key] += legacy.tokens[key];
      }
      if (isNonnegative(legacy.costUsd)) usage.knownCostUsd = (usage.knownCostUsd ?? 0) + legacy.costUsd;
      usage.partial = true;
    } else if (state.launched !== null) {
      usage.missingSources++;
      usage.partial = true;
    }
  }

  const declaredTickets = new Set(declared.map(contact => contact.ticket));
  for (const [ticket, state] of Object.entries(fold.contacts)) {
    if (!state.paneEvents) continue;
    const pane = usage.pane ?? (usage.pane = { tokens: 0, costUsd: null, sessions: 0 });
    pane.tokens += state.paneTokens;
    pane.sessions += state.paneSessions;
    if (state.paneCostUsd !== null) {
      pane.costUsd = (pane.costUsd ?? 0) + state.paneCostUsd;
      usage.knownCostUsd = (usage.knownCostUsd ?? 0) + state.paneCostUsd;
    }
    if (!declaredTickets.has(ticket)) {
      // Removing intent must not remove recorded spend, or invent delivery/timing observations.
      const row = phaseRow(usage, DECISION_PHASE);
      row.tokens += state.paneTokens;
      if (state.paneCostUsd !== null) row.costUsd = (row.costUsd ?? 0) + state.paneCostUsd;
      usage.malformedLines += state.paneMalformed;
      usage.partial ||= state.paneTruncated || state.paneMalformed > 0;
    }
  }

  for (const source of fold.sources.values()) {
    usage.tokens ??= emptyTokens();
    for (const key of TOKEN_KEYS) usage.tokens[key] += source.tokens[key];
    if (source.costUsd !== null) usage.knownCostUsd = (usage.knownCostUsd ?? 0) + source.costUsd;
    usage.pricedMessages! += source.pricedMessages;
    usage.unpricedMessages! += source.unpricedMessages;
    if (source.role === "coordinator") usage.coordinatorSessionAssociated = true;
  }

  result.coverage.legacyUsage = legacyContacts;
  if (scopedContacts) usage.basis = legacyContacts ? "mixed" : "scoped";
  else usage.basis = legacyContacts ? "legacy" : "missing";
  // Legacy totals carry no message counts, so any legacy contact makes the operation's counts unknown.
  if (legacyContacts) {
    usage.pricedMessages = null;
    usage.unpricedMessages = null;
  }
  usage.partial ||= usage.resets > 0 || fold.resets > 0 || (usage.unpricedMessages ?? 0) > 0;
  usage.costPerDelivered = result.deliveredWork > 0 && usage.knownCostUsd !== null ? usage.knownCostUsd / result.deliveredWork : null;
}

/**
 * Rework and review from producer measurements: verification/review failures and repairs summed over runs,
 * fleet dispatch counts, and latest-round findings (latest run per contact only, so they never accumulate).
 */
function evaluateQuality(result: Evaluation, fold: FoldEvaluation): void {
  const { fleet } = result;
  for (const [key, run] of fold.runs) {
    const measured = run.measurements;
    const quality = result.quality ??= { since: measured.since, recordedPassed: 0, recordedFailed: 0, repeatedFailedRevision: 0, mergePreflightFailures: 0, boundaryFailures: 0, reviewFailures: 0, acceptedRepairs: 0, completedRounds: 0, invalidatedRounds: 0, findingOccurrences: 0, latestActionable: 0, latestRejected: 0, severity: emptySeverity() };
    if (measured.since < quality.since) quality.since = measured.since;
    for (const field of HISTORICAL_COUNTS) quality[field] += measured[field];
    fleet.workerAttempts = (fleet.workerAttempts ?? 0) + measured.workerAttempts;
    fleet.workerBeads = (fleet.workerBeads ?? 0) + measured.workerBeads;
    fleet.redispatches = (fleet.redispatches ?? 0) + Math.max(0, measured.workerAttempts - measured.workerBeads);
    fleet.repairRound = Math.max(fleet.repairRound ?? 0, measured.repairRound);
    if (fold.contacts[run.contact]?.latestRun === key) {
      fleet.repairLinks = (fleet.repairLinks ?? 0) + measured.repairLinks;
      quality.latestActionable += measured.latestActionable;
      quality.latestRejected += measured.latestRejected;
      for (const level of SEVERITIES) quality.severity[level] += measured.severity[level];
    }
  }
}

export function evaluateOperation(operation: Operation, derived: Derived, now: number): Evaluation {
  const fold = derived.evaluation ?? createFoldEvaluation();
  const clock = fold.closed ?? Math.max(now, fold.clock ?? now);
  const createdAt = Date.parse(operation.createdAt);
  const elapsed = Math.max(0, clock - createdAt);
  const result = emptyEvaluation(fold, clock);
  const timelines: Timeline[] = [];
  for (const contact of operation.contacts) {
    const original = fold.contacts[contact.ticket];
    if (!original) continue;
    // Accrue on a copy: the fold state must stay valid for the next event.
    const state = { ...original, phaseMs: { ...original.phaseMs }, holdMs: { ...original.holdMs }, blockedByMs: Object.assign(Object.create(null), original.blockedByMs) };
    accrue(state, clock);
    timelines.push({ contact, state });
  }
  evaluateDelivery(result, timelines, clock, elapsed);
  evaluateTime(result, timelines);
  evaluateAttempts(result, timelines);
  evaluateUsage(result, timelines, fold, operation.contacts);
  evaluateQuality(result, fold);
  evaluateContacts(result, timelines, fold);
  evaluateActivity(result, timelines, clock, elapsed);
  evaluateSeries(result, timelines, fold, createdAt, clock);
  evaluateStalls(result, timelines);
  evaluateConflicts(result, timelines, fold);
  const autoLand = operation.auto?.enabled === true && operation.auto.land === true;
  result.recommendations = recommendEvaluation(result, evaluationEvidence(operation, derived, clock), { autoLand });
  return result;
}
