import type { Contact, UsageSource } from "../types.ts";
import { isNonnegative, isWork, sumTokens, TOKEN_KEYS } from "./shared.ts";
import type {
  ContactEvaluation, ContactFinalState, ContactReport, Evaluation, FoldEvaluation, FoldWaitKind, OperatorWaitEvaluation,
  SpendEvaluation, Timeline, WaitKind, WaitTotals,
} from "./types.ts";

const FOLD_WAIT_KINDS: readonly FoldWaitKind[] = ["ready", "plan-approval", "gate", "question", "resume", "land"];
/** Payload order of `operatorWait.byKind`. */
const WAIT_KINDS: readonly WaitKind[] = ["launch", "decision", "plan-approval", "gate", "question", "resume", "land"];

const emptyWait = (): WaitTotals => ({ operatorMs: 0, automationMs: 0, pendingMs: 0, waits: 0 });

function finalState(state: ContactEvaluation): ContactFinalState {
  if (state.landed !== null) return "landed";
  if (!state.active) return state.endedBy ?? "closed";
  if (state.launched === null) {
    if (state.blocked) return "blocked";
    return state.queued !== null ? "queued" : "unqueued";
  }
  if (state.offline) return "offline";
  if (state.completeAt !== null) return "complete";
  if ((state.hold !== null && state.hold !== "none") || state.gate !== null) return "hold";
  return "running";
}

/** The contact's settled, unclaimed and open waits by reported kind; the fold state is not modified. */
function contactWaits(contact: Contact, state: ContactEvaluation): Map<WaitKind, WaitTotals> {
  const waits = new Map<WaitKind, WaitTotals>();
  const row = (kind: FoldWaitKind) => {
    let reported: WaitKind;
    if (kind !== "ready") reported = kind;
    else reported = contact.kind === "decision" ? "decision" : "launch";
    let totals = waits.get(reported);
    if (!totals) waits.set(reported, totals = emptyWait());
    return totals;
  };
  for (const kind of FOLD_WAIT_KINDS) {
    const account = state.waits[kind];
    if (!account) continue;
    const totals = row(kind);
    totals.operatorMs += account.operatorMs;
    totals.automationMs += account.automationMs;
    totals.waits += account.waits;
  }
  if (state.unsettled !== null) row(state.unsettled.kind).operatorMs += state.unsettled.ms;
  if (state.wait !== null) row(state.wait).pendingMs += state.waitMs;
  return waits;
}

interface ContactSpend { report: ContactReport["spend"]; ownUsd: number | null }

/** Spend of sources the contact first observed, its legacy totals (when unscoped) and its panes; panes stay out of `ownUsd`. */
function contactSpend(state: ContactEvaluation, owned: readonly UsageSource[]): ContactSpend {
  let tokens: number | null = null;
  let ownUsd: number | null = null;
  // Legacy totals carry no message counts, so only scoped evidence can be complete.
  let complete = (state.scoped || state.launched === null) && !state.partial && !state.unknown && state.missing === 0 && state.unsupported === 0;
  for (const source of owned) {
    tokens = (tokens ?? 0) + sumTokens(source.tokens);
    if (source.costUsd !== null) ownUsd = (ownUsd ?? 0) + source.costUsd;
    if (source.costUsd === null || source.unpricedMessages > 0) complete = false;
  }
  if (!state.scoped && state.legacy) {
    const legacy = state.legacy;
    if (TOKEN_KEYS.every(key => isNonnegative(legacy.tokens[key]))) tokens = (tokens ?? 0) + sumTokens(legacy.tokens);
    if (isNonnegative(legacy.costUsd)) ownUsd = (ownUsd ?? 0) + legacy.costUsd;
  }
  let costUsd = ownUsd;
  if (state.paneEvents) {
    tokens = (tokens ?? 0) + state.paneTokens;
    if (state.paneCostUsd !== null) costUsd = (costUsd ?? 0) + state.paneCostUsd;
    if (state.paneCostUsd === null || state.paneTruncated || state.paneMalformed > 0) complete = false;
  }
  return { report: { tokens, costUsd, complete: complete && costUsd !== null }, ownUsd };
}

function reviewTotals(fold: FoldEvaluation): Map<string, { rounds: number; findings: number; failures: number }> {
  const totals = new Map<string, { rounds: number; findings: number; failures: number }>();
  for (const run of fold.runs.values()) {
    let row = totals.get(run.contact);
    if (!row) totals.set(run.contact, row = { rounds: 0, findings: 0, failures: 0 });
    row.rounds += run.measurements.completedRounds;
    row.findings += run.measurements.findingOccurrences;
    row.failures += run.measurements.reviewFailures;
  }
  return totals;
}

function ownedSources(fold: FoldEvaluation): Map<string, UsageSource[]> {
  const owned = new Map<string, UsageSource[]>();
  for (const [key, source] of fold.sources) {
    const owner = fold.sourceOwners.get(key);
    if (owner === undefined) continue;
    let list = owned.get(owner);
    if (!list) owned.set(owner, list = []);
    list.push(source);
  }
  return owned;
}

const sumWaits = (into: WaitTotals, from: WaitTotals) => {
  into.operatorMs += from.operatorMs;
  into.automationMs += from.automationMs;
  into.pendingMs += from.pendingMs;
  into.waits += from.waits;
};

/**
 * Per-contact breakdown, operator-wait totals and the known-spend split. Waits a closed interval left unclaimed
 * count as operator waits; the open one is pending.
 */
export function evaluateContacts(result: Evaluation, timelines: readonly Timeline[], fold: FoldEvaluation): void {
  const owned = ownedSources(fold);
  const reviews = reviewTotals(fold);
  const operatorWait: OperatorWaitEvaluation = { ...emptyWait(), missionMs: 0, byKind: {} };
  const byKind = new Map<WaitKind, WaitTotals>();
  const spend: SpendEvaluation = {
    landedUsd: 0, landedPriced: 0, perLandedUsd: null, supportUsd: 0, openUsd: 0, abandonedUsd: 0, paneUsd: 0, wastedUsd: 0, knownShare: null, pricedShare: null,
  };
  let launched = 0, known = 0;
  const reports: ContactReport[] = [];

  for (const { contact, state } of timelines) {
    const waits = contactWaits(contact, state);
    const waitTotals = emptyWait();
    for (const [kind, totals] of waits) {
      sumWaits(waitTotals, totals);
      let aggregate = byKind.get(kind);
      if (!aggregate) byKind.set(kind, aggregate = emptyWait());
      sumWaits(aggregate, totals);
    }
    sumWaits(operatorWait, waitTotals);
    operatorWait.missionMs += state.ownMs;

    const { report: spent, ownUsd } = contactSpend(state, owned.get(contact.ticket) ?? []);
    if (state.launched !== null) {
      launched++;
      if (spent.complete) known++;
    }
    let outcome: ContactReport["outcome"] = "open";
    if (state.landed !== null) outcome = "landed";
    else if (!state.active) outcome = "abandoned";
    if (ownUsd !== null) {
      if (outcome === "landed" && isWork(contact)) {
        spend.landedUsd! += ownUsd;
        spend.landedPriced++;
      } else if (outcome === "landed") spend.supportUsd! += ownUsd;
      else if (outcome === "abandoned") spend.abandonedUsd! += ownUsd;
      else spend.openUsd! += ownUsd;
    }

    const review = reviews.get(contact.ticket);
    const by = state.relaunchBy;
    const relaunches = Math.max(0, state.launches - 1);
    reports.push({
      ticket: contact.ticket, kind: contact.kind, state: finalState(state), outcome, phase: state.phase, hold: state.hold,
      queuedAt: state.queued, launchedAt: state.launched, landedAt: state.landed, endedAt: state.ended,
      leadMs: state.queued !== null && state.landed !== null ? Math.max(0, state.landed - state.queued) : null,
      activeMs: state.liveMs,
      blockedMs: { beforeLaunch: state.blockedMs ?? 0, afterLaunch: state.blockedAfterMs, by: { ...state.blockedByMs } },
      phaseMs: { ...state.phaseMs },
      offlineMs: state.offlineMs ?? 0,
      waitMs: { operator: waitTotals.operatorMs, automation: waitTotals.automationMs, pending: waitTotals.pendingMs },
      review: review ? { ...review, perRound: state.rounds.map(round => ({ ...round })) } : null,
      relaunches: { total: relaunches, operator: by.operator, recovery: by.recovery, auto: by.auto, other: Math.max(0, relaunches - by.operator - by.recovery - by.auto) },
      launchFailures: state.launchFailures,
      conflicts: { count: state.conflicts, landAttempts: state.landAttempts, paths: [...state.conflictPaths].reverse() },
      spend: spent,
    });
  }

  // Sources first seen by contacts no longer declared: spend on removed intent.
  const declared = new Set(timelines.map(({ contact }) => contact.ticket));
  for (const [ticket, sources] of owned) {
    if (declared.has(ticket)) continue;
    for (const source of sources) if (source.costUsd !== null) spend.abandonedUsd! += source.costUsd;
  }
  for (const kind of WAIT_KINDS) {
    const totals = byKind.get(kind);
    if (totals) operatorWait.byKind[kind] = totals;
  }

  const { usage } = result;
  if (usage.knownCostUsd === null) {
    spend.landedUsd = spend.supportUsd = spend.openUsd = spend.abandonedUsd = spend.paneUsd = spend.wastedUsd = null;
  } else {
    spend.paneUsd = usage.pane?.costUsd ?? 0;
    spend.wastedUsd = spend.abandonedUsd! + spend.paneUsd;
    spend.perLandedUsd = spend.landedPriced > 0 ? spend.landedUsd! / spend.landedPriced : null;
  }
  spend.knownShare = launched > 0 ? known / launched : null;
  const messages = (usage.pricedMessages ?? 0) + (usage.unpricedMessages ?? 0);
  spend.pricedShare = usage.pricedMessages !== null && usage.unpricedMessages !== null && messages > 0 ? usage.pricedMessages / messages : null;

  usage.spend = spend;
  result.contacts = reports;
  result.operatorWait = operatorWait;
}
