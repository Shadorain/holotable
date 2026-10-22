import type { Contact, Derived, Operation } from "../types.ts";
import { createFoldEvaluation } from "./fold.ts";
import { distribution, isWork } from "./shared.ts";
import type { ContactEvaluation, ContactEvidence, Evaluation, EvaluationEvidence, EventRef, Recommendation, RunEvidence } from "./types.ts";

const MAX_RECOMMENDATIONS = 6;
/** Evidence rows cited per recommendation (contacts and event indexes). */
const MAX_CITED = 3;
const TEN_MINUTES_MS = 600_000;

/** Rule thresholds: below these sample sizes or shares a pattern is noise, not a signal. */
const RULES = {
  repeatVerification: { minRepeats: 2 },
  reviewRetries: { minFailures: 3 },
  integrationConflicts: { minLandAttempts: 5, minConflicts: 2, minShare: .3 },
  relaunchChurn: { minLaunches: 10, minRelaunches: 5, minShare: .4 },
  approvalWait: { minContacts: 3, minHoldMs: TEN_MINUTES_MS, minShareOfLifetime: .3 },
  deliveryWait: { minContacts: 3, minMedianMs: TEN_MINUTES_MS },
  dependencyWait: { minBlockedMs: TEN_MINUTES_MS, minShareOfLifetime: .5 },
  phaseCost: { minAttributedTokens: 100_000_000, minReviewShare: .4 },
} as const;
/** Rules whose judgement changed since evaluations shipped; the rest stay at version 1. v2: judge the recent window. */
const RULE_VERSIONS: Partial<Record<string, number>> = { "repeat-verification": 2, "review-retries": 2, "relaunch-churn": 2 };

function contactEvidence(contact: Contact, state: ContactEvaluation | undefined, clock: number): ContactEvidence {
  const ticket = contact.ticket;
  if (!state) {
    return { ticket, launches: 0, lifetimeMs: null, gateHoldMs: null, blockedMs: 0, finalReadyMs: null, gateEventIndexes: [], blockedEventIndexes: [], deliveryEventIndexes: [], launchEventIndexes: [] };
  }
  // The fold accrues lazily; add the still-open interval up to the clock.
  const openMs = state.active ? Math.max(0, clock - state.at) : 0;
  const holdingGate = state.hold === "gate";
  const blockedBeforeLaunch = state.blocked === true && state.launched === null;
  return {
    ticket,
    launches: state.launches,
    lifetimeMs: state.launched === null ? null : Math.max(0, (state.landed ?? state.ended ?? clock) - state.launched),
    gateHoldMs: state.holdMs.gate === undefined && !holdingGate ? null : (state.holdMs.gate ?? 0) + (holdingGate ? openMs : 0),
    blockedMs: state.blockedMs === null && !blockedBeforeLaunch ? null : (state.blockedMs ?? 0) + (blockedBeforeLaunch ? openMs : 0),
    finalReadyMs: state.completeAt !== null && state.landed !== null && isWork(contact) ? Math.max(0, state.landed - state.completeAt) : null,
    gateEventIndexes: state.gateRefs,
    blockedEventIndexes: state.blockedRefs,
    deliveryEventIndexes: state.readyRefs,
    launchEventIndexes: state.launchRefs,
  };
}

/** Per-contact durations and cited event indexes the recommendation rules rank and quote. */
export function evaluationEvidence(operation: Operation, derived: Derived, now: number): EvaluationEvidence {
  const fold = derived.evaluation ?? createFoldEvaluation();
  const clock = fold.closed ?? Math.max(now, fold.clock ?? now);
  const contacts = operation.contacts.map(contact => contactEvidence(contact, fold.contacts[contact.ticket], clock));
  // Cite the newest samples, preferring contacts whose accounting is incomplete.
  const sampled = operation.contacts
    .map(contact => ({ contact: contact.ticket, state: fold.contacts[contact.ticket] }))
    .filter(row => row.state !== undefined && row.state.usageRef !== null)
    .sort((a, b) => b.state!.usageRef! - a.state!.usageRef!);
  const incomplete = sampled.filter(({ state }) => state!.partial || state!.unknown || !state!.scoped);
  const usageEvents = (incomplete.length ? incomplete : sampled).slice(0, MAX_CITED).map(row => ({ contact: row.contact, index: row.state!.usageRef! }));
  return { runs: [...fold.runs.values()], contacts, conflictEvents: [...fold.conflicts].reverse(), usageEvents };
}

type Stake = NonNullable<Recommendation["impact"]>;

function recommendation(id: string, level: Recommendation["level"], message: string, numerator: number, denominator: number | null, observedMs: number | null, rows: EventRef[], caveat: string, impact: Stake): Recommendation {
  const contacts = [...new Set(rows.map(row => row.contact))].slice(0, MAX_CITED);
  const eventIndexes = rows.slice(0, MAX_CITED).map(row => row.index);
  return { id, ruleVersion: RULE_VERSIONS[id] ?? 1, level, message, evidence: { numerator, denominator, observedMs, contacts, eventIndexes }, caveat, impact };
}

/** Cites each contact's newest event first, highest score first, then their older events. */
function rankContacts(list: ContactEvidence[], score: (contact: ContactEvidence) => number, indexes: (contact: ContactEvidence) => number[]): EventRef[] {
  const ordered = list.filter(contact => indexes(contact).length > 0).sort((a, b) => score(b) - score(a) || a.ticket.localeCompare(b.ticket));
  const newest = ordered.map(contact => ({ contact: contact.ticket, index: indexes(contact).at(-1)! }));
  const older = ordered.flatMap(contact => indexes(contact).slice(0, -1).map(index => ({ contact: contact.ticket, index })));
  return [...newest, ...older];
}

/** The run with the highest `field`, ties broken by `contact:mission` for a stable pick. */
function worstRun(runs: RunEvidence[], field: "repeatedFailedRevision" | "reviewFailures"): RunEvidence | undefined {
  let worst: RunEvidence | undefined;
  for (const run of runs) {
    if (!worst) { worst = run; continue; }
    const value = run.measurements[field], best = worst.measurements[field];
    if (value > best || (value === best && `${run.contact}:${run.missionId}` < `${worst.contact}:${worst.missionId}`)) worst = run;
  }
  return worst;
}

/** Newest first: the run ring keeps its latest indexes oldest-first. */
const runRefs = (run: RunEvidence): EventRef[] => run.eventIndexes.map(index => ({ contact: run.contact, index })).reverse();

/** A nullable sum: null when no term is known. */
function sumKnown(values: Array<number | null>): number | null {
  let total: number | null = null;
  for (const value of values) if (value !== null) total = (total ?? 0) + value;
  return total;
}

/**
 * Every rule is a threshold check; those that fire are ranked by what they put at stake (time, or known spend
 * converted to time at the operation's spend per active hour), ties in rule order, and the top MAX_RECOMMENDATIONS kept.
 * With launch cohorts, the per-contact count rules (repeat verification, review retries, relaunch churn) judge only
 * contacts first launched since the recent cohort's first launch, open and abandoned ones included, so history the
 * operation has moved past stops firing; Early vs recent keeps it visible.
 */
export function recommendEvaluation(evaluation: Evaluation, proof: EvaluationEvidence, opts: { autoLand?: boolean } = {}): Recommendation[] {
  const { attempts, coverage, usage } = evaluation;
  const timed = proof.contacts.filter(contact => contact.lifetimeMs !== null);
  const lifetimeMs = timed.reduce((total, contact) => total + contact.lifetimeMs!, 0);
  const reports = evaluation.contacts ?? [];
  const recent = evaluation.launchCohorts?.recent;
  const recentTickets = recent ? new Set(reports.filter(row => row.launchedAt !== null && row.launchedAt >= recent.firstLaunchAt).map(row => row.ticket)) : null;
  const inWindow = (ticket: string) => recentTickets === null || recentTickets.has(ticket);
  const windowed = (caveat: string) => recentTickets === null ? caveat
    : `Judged on the ${recentTickets.size} contacts first launched since the recent cohort began; earlier contacts are left out. ${caveat}`;
  const recentRuns = proof.runs.filter(run => inWindow(run.contact));
  const activeMs = evaluation.activity?.activeMs ?? 0;
  const usdPerMs = usage.knownCostUsd !== null && usage.knownCostUsd > 0 && activeMs > 0 ? usage.knownCostUsd / activeMs : null;
  const stake = (ms: number | null, usd: number | null): Stake => ({
    ms, usd, scoreMs: Math.max(ms ?? 0, usd !== null && usdPerMs !== null ? usd / usdPerMs : 0),
  });

  const usageCoverage = (): Recommendation | null => {
    if (!coverage.launched || !(usage.partial || coverage.legacyUsage || usage.backlogBytes)) return null;
    return recommendation("usage-coverage", "info", "Inspect accounting coverage before comparing costs.", coverage.usageReported, coverage.launched, null, proof.usageEvents,
      `${usage.missingSources} missing, ${usage.unsupportedWorkers} unsupported; ${usage.unpricedMessages ?? "unknown"} unpriced messages; ${usage.malformedLines} malformed lines; ${usage.resets + coverage.counterResets} reset observations; ${usage.backlogBytes} backlog bytes. Historical gaps and associated sessions prevent exclusive mission billing.`,
      stake(null, null));
  };
  const repeatVerification = (): Recommendation | null => {
    const run = worstRun(recentRuns, "repeatedFailedRevision");
    if (!run || run.measurements.repeatedFailedRevision < RULES.repeatVerification.minRepeats) return null;
    const contact = reports.find(row => row.ticket === run.contact);
    return recommendation("repeat-verification", "warning", "Inspect repeated verification evidence and repair scope.", run.measurements.repeatedFailedRevision, run.measurements.recordedFailed, null, runRefs(run),
      windowed("Consecutive failed records share a fingerprint, not necessarily a root cause."), stake(contact?.activeMs ?? null, contact?.spend.costUsd ?? null));
  };
  const reviewRetries = (): Recommendation | null => {
    const run = worstRun(recentRuns, "reviewFailures");
    if (!run || run.measurements.reviewFailures < RULES.reviewRetries.minFailures) return null;
    const reviewMs = reports.find(row => row.ticket === run.contact)?.phaseMs.review ?? null;
    return recommendation("review-retries", "warning", "Inspect reviewer failure evidence, provider capacity and revision churn.", run.measurements.reviewFailures, null, null, runRefs(run),
      windowed("Failed review operations are not completed rounds or proof of defects."), stake(reviewMs, null));
  };
  const integrationConflicts = (): Recommendation | null => {
    const rule = RULES.integrationConflicts;
    if (attempts.landAttempts < rule.minLandAttempts || attempts.conflicts < rule.minConflicts || attempts.conflicts / attempts.landAttempts < rule.minShare) return null;
    const helpers = reports.filter(contact => contact.kind === "conflict");
    return recommendation("integration-conflicts", "warning", "Inspect shared paths and delivery ordering before increasing parallelism.", attempts.conflicts, attempts.landAttempts, null, proof.conflictEvents,
      "Observed conflicts do not establish concurrency as their cause.",
      stake(sumKnown(helpers.map(contact => contact.activeMs)), sumKnown(helpers.map(contact => contact.spend.costUsd))));
  };
  const relaunchChurn = (): Recommendation | null => {
    const rule = RULES.relaunchChurn;
    const launches = (contact: ContactEvidence) => contact.launches ?? contact.launchEventIndexes.length;
    const judged = proof.contacts.filter(contact => inWindow(contact.ticket));
    const launched = judged.reduce((total, contact) => total + launches(contact), 0);
    const relaunches = judged.reduce((total, contact) => total + Math.max(0, launches(contact) - 1), 0);
    if (launched < rule.minLaunches || relaunches < rule.minRelaunches || relaunches / launched < rule.minShare) return null;
    const relaunched = judged.filter(contact => launches(contact) > 1);
    return recommendation("relaunch-churn", "warning", "Inspect relaunch causes before assuming restarts are routine.", relaunches, launched, null, rankContacts(relaunched, launches, contact => contact.launchEventIndexes),
      windowed("Recorded relaunches include deliberate operator relaunches; churn does not prove pane death or wasted execution."),
      stake(sumKnown(reports.filter(contact => contact.relaunches.total > 0 && inWindow(contact.ticket)).map(contact => contact.offlineMs)), null));
  };
  const approvalWait = (): Recommendation | null => {
    const rule = RULES.approvalWait;
    const gated = proof.contacts.filter(contact => contact.gateHoldMs !== null && contact.gateHoldMs > 0 && contact.lifetimeMs !== null);
    const gateMs = gated.reduce((total, contact) => total + contact.gateHoldMs!, 0);
    if (gated.length < rule.minContacts || gateMs < rule.minHoldMs || lifetimeMs <= 0 || gateMs / lifetimeMs < rule.minShareOfLifetime) return null;
    return recommendation("approval-wait", "info", "Review approval availability and batching without bypassing gates.", gated.length, timed.length, gateMs, rankContacts(gated, contact => contact.gateHoldMs!, contact => contact.gateEventIndexes),
      "Observed hold time overlaps phase time and is not exclusive human response time.", stake(gateMs, null));
  };
  const deliveryWait = (): Recommendation | null => {
    const ready = proof.contacts.filter(contact => contact.finalReadyMs !== null);
    const medianMs = distribution(ready.map(contact => contact.finalReadyMs!)).medianMs;
    if (ready.length < RULES.deliveryWait.minContacts || medianMs === null || medianMs < RULES.deliveryWait.minMedianMs) return null;
    const message = opts.autoLand === false
      ? "Ready work is waiting on an operator Land click; enable auto.land or inspect delivery checks."
      : "Inspect delivery checks and integration availability.";
    return recommendation("delivery-wait", "info", message, ready.length, evaluation.deliveredWork, medianMs, rankContacts(ready, contact => contact.finalReadyMs!, contact => contact.deliveryEventIndexes),
      "Observed ready-to-land delay does not establish which delivery dependency caused it.", stake(ready.reduce((total, contact) => total + contact.finalReadyMs!, 0), null));
  };
  const dependencyWait = (): Recommendation | null => {
    const waitMs = evaluation.dependencyWaitMs;
    if (waitMs === null || waitMs < RULES.dependencyWait.minBlockedMs || lifetimeMs <= 0 || waitMs < RULES.dependencyWait.minShareOfLifetime * lifetimeMs) return null;
    const blocked = proof.contacts.filter(contact => contact.blockedMs !== null && contact.blockedMs > 0);
    return recommendation("dependency-wait", "info", "Inspect the blocking chain and launch order before widening the fleet.", waitMs, lifetimeMs, waitMs, rankContacts(blocked, contact => contact.blockedMs!, contact => contact.blockedEventIndexes),
      "Blocked time before launch can exceed launched lifetime and overlaps queue wait; it does not identify which predecessor should have run first.", stake(waitMs, null));
  };
  const phaseCost = (): Recommendation | null => {
    const review = usage.byPhase?.review;
    const attributed = usage.byPhase ? Object.values(usage.byPhase).reduce((total, row) => total + row.tokens, 0) : 0;
    if (review === undefined || attributed < RULES.phaseCost.minAttributedTokens || review.tokens / attributed < RULES.phaseCost.minReviewShare) return null;
    return recommendation("phase-cost", "info", "Inspect review-phase token share; narrow review scope or model tier if review dominates attributed spend.", review.tokens, attributed, null, proof.usageEvents,
      "Review-phase tokens include coordinator-session spend during review and are not exclusively reviewer cost.", stake(null, review.costUsd));
  };

  const rules = [usageCoverage, repeatVerification, reviewRetries, integrationConflicts, relaunchChurn, approvalWait, deliveryWait, dependencyWait, phaseCost];
  const fired = rules.map(rule => rule()).filter((rule): rule is Recommendation => rule !== null);
  // Array sort is stable: equal stakes keep rule order.
  return fired.sort((a, b) => b.impact!.scoreMs - a.impact!.scoreMs).slice(0, MAX_RECOMMENDATIONS);
}
