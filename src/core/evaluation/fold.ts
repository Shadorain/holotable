import type { Event, Measurements, UsageEvidence, UsageSource, UsageTotals } from "../types.ts";
import { DECISION_PHASE, HISTORICAL_COUNTS, isNonnegative, MS_PER_HOUR, sumTokens, TOKEN_KEYS } from "./shared.ts";
import type { ContactEvaluation, FoldEvaluation, FoldWaitKind, WaitActor } from "./types.ts";

/** Evidence rings keep the most recent event indexes a recommendation can cite. */
const REF_RING = 3;
/** Pane ids remembered for dedupe beyond the monotonic `pane:<n>` sequence. */
const PANE_ID_RING = 8;
const UNKNOWN_PHASE = "unknown";
/** A wait whose resolving action is appended after it closes (Land, Launch) settles if that action follows within this. */
const SETTLE_MS = 60_000;
/** Distinct conflicting paths tracked per operation, and per contact. */
const MAX_CONFLICT_PATHS = 500;
const CONTACT_PATHS = 10;
const PATH_CONTACTS = 3;
const MAX_ROUNDS = 10;

/** Successful actions, by `op`, that end operator waits of these kinds. */
const RESOLVES: Record<string, readonly FoldWaitKind[]> = {
  launch: ["ready"], "plan-approve": ["plan-approval"], approve: ["gate"], answer: ["question"], permit: ["question"],
  continue: ["resume"], land: ["land"], "land-anyway": ["land"], done: ["ready", "land"],
};
const DECIDED: readonly FoldWaitKind[] = ["ready", "land"];

type SampleEvent = Extract<Event, { kind: "sample" }>;
type PaneUsageEvent = Extract<Event, { kind: "pane-usage" }>;
type OperatorEvent = Extract<Event, { kind: "operator" }>;

export function createFoldEvaluation(): FoldEvaluation {
  return {
    clock: null, closed: null, anomalies: 0, resets: 0, contacts: Object.create(null), runs: new Map(), sources: new Map(), connected: 0, peak: 0, connectedMs: 0, connectivityFrom: null, config: { value: null, mixed: false }, conflicts: [],
    series: new Map(), conflictPaths: new Map(), unpathedConflicts: 0, droppedPaths: 0, sourceOwners: new Map(),
  };
}

function newContact(at: number): ContactEvaluation {
  return {
    queued: null, launched: null, landed: null, ended: null, at, active: true, phase: null, gate: null, hold: null,
    blocked: null, socket: false, offline: false, workerValue: null,
    phaseMs: Object.create(null), gateMs: null, offlineMs: null, blockedMs: null, holdMs: {}, workerMs: 0, coveredMs: 0, completeAt: null,
    launches: 0, launchFailures: 0, landAttempts: 0, conflicts: 0, resends: 0,
    mission: null, latestRun: null, unknown: false, scoped: false, missing: 0, unsupported: 0, malformed: 0, resets: 0, backlog: 0, partial: false,
    gateRefs: [], readyRefs: [], launchRefs: [], blockedRefs: [], usageRef: null, legacy: null, legacyTotals: null, legacyCostUsd: null,
    phaseTokens: {}, phaseCostUsd: {},
    paneIds: [], paneTokens: 0, paneCostUsd: null, paneSessions: 0, paneEmittedTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    paneEmittedCostUsd: 0, paneMalformed: 0, paneTruncated: false, paneEvents: 0,
    liveMs: 0, ownMs: 0, blockedAfterMs: 0, blockedPost: false, blockedBy: [], blockedByMs: Object.create(null), endedBy: null,
    relaunchBy: { operator: 0, recovery: 0, auto: 0 }, refusals: { memory: 0, sessionCap: 0, refused: 0, gaveUp: 0 },
    conflictPaths: [], quotaEpisodes: 0, offlineEpisodes: 0,
    wait: null, waitFrom: at, waitMs: 0, waits: {}, unsettled: null, resolved: null, rounds: [], busySpans: [],
  };
}

function pushRef(ring: number[], index: number): void {
  if (ring.length === REF_RING) ring.shift();
  ring.push(index);
}

function addPhaseSpend(contact: ContactEvaluation, phase: string, tokens: number, costUsd: number): void {
  if (tokens > 0) contact.phaseTokens[phase] = (contact.phaseTokens[phase] ?? 0) + tokens;
  if (costUsd > 0) contact.phaseCostUsd[phase] = (contact.phaseCostUsd[phase] ?? 0) + costUsd;
}

/** Credits the interval since the contact's last event to whatever state it was in during it. */
export function accrue(contact: ContactEvaluation, at: number): void {
  const elapsed = Math.max(0, at - contact.at);
  if (contact.active) {
    if (contact.phase !== null) contact.phaseMs[contact.phase] = (contact.phaseMs[contact.phase] ?? 0) + elapsed;
    if (contact.gate !== null) contact.gateMs = (contact.gateMs ?? 0) + elapsed;
    if (contact.offline) contact.offlineMs = (contact.offlineMs ?? 0) + elapsed;
    if (contact.blocked && contact.launched === null) contact.blockedMs = (contact.blockedMs ?? 0) + elapsed;
    if (contact.blocked && contact.launched !== null && contact.blockedPost) contact.blockedAfterMs += elapsed;
    // A block that began before launch stops counting once the contact launches anyway.
    if (contact.blocked && (contact.launched === null || contact.blockedPost))
      for (const by of contact.blockedBy) contact.blockedByMs[by] = (contact.blockedByMs[by] ?? 0) + elapsed;
    if (contact.hold !== null && contact.hold !== "none") contact.holdMs[contact.hold] = (contact.holdMs[contact.hold] ?? 0) + elapsed;
    if (contact.socket && contact.workerValue !== null) {
      contact.coveredMs += elapsed;
      contact.workerMs += elapsed * contact.workerValue;
    }
    if (contact.launched !== null) {
      contact.liveMs += elapsed;
      if (contact.wait === null) contact.ownMs += elapsed;
    }
    if (contact.wait !== null) contact.waitMs += elapsed;
  }
  contact.at = at;
}

/** The operator wait a contact is in: ready to launch/decide, held on a prompt or gate, or complete and unlanded. */
function waitKindOf(contact: ContactEvaluation): FoldWaitKind | null {
  if (!contact.active || contact.landed !== null) return null;
  if (contact.launched === null) return contact.queued !== null && contact.blocked !== true ? "ready" : null;
  if (contact.hold === "question" || contact.hold === "plan-approval" || contact.hold === "resume" || contact.hold === "gate") return contact.hold;
  if (contact.gate !== null) return "gate";
  return contact.completeAt !== null ? "land" : null;
}

function creditWait(contact: ContactEvaluation, kind: FoldWaitKind, actor: WaitActor, ms: number): void {
  const account = contact.waits[kind] ??= { operatorMs: 0, automationMs: 0, waits: 0 };
  if (actor === "operator") account.operatorMs += ms;
  else account.automationMs += ms;
}

/** A closed wait no action claimed: the operator never acted through the board (or acted in the pane). */
function settleUnclaimed(contact: ContactEvaluation): void {
  if (contact.unsettled === null) return;
  creditWait(contact, contact.unsettled.kind, "operator", contact.unsettled.ms);
  contact.unsettled = null;
}

/** Closes the open wait when the contact's state moved to another (or none), crediting whoever resolved it. */
function updateWait(contact: ContactEvaluation, at: number): void {
  const kind = waitKindOf(contact);
  if (kind === contact.wait) return;
  const closing = contact.wait;
  if (closing !== null) {
    const resolved = contact.resolved;
    if (resolved !== null && resolved.kinds.includes(closing) && resolved.at >= contact.waitFrom) creditWait(contact, closing, resolved.actor, contact.waitMs);
    else {
      settleUnclaimed(contact);
      contact.unsettled = { kind: closing, ms: contact.waitMs, at };
    }
  }
  contact.wait = kind;
  contact.waitFrom = at;
  contact.waitMs = 0;
  if (kind !== null) (contact.waits[kind] ??= { operatorMs: 0, automationMs: 0, waits: 0 }).waits++;
}

function resolveWait(contact: ContactEvaluation, kinds: readonly FoldWaitKind[], actor: WaitActor, at: number): void {
  contact.resolved = { kinds, actor, at };
  const unsettled = contact.unsettled;
  if (unsettled !== null && kinds.includes(unsettled.kind) && at - unsettled.at <= SETTLE_MS) {
    creditWait(contact, unsettled.kind, actor, unsettled.ms);
    contact.unsettled = null;
  }
}

/** Opens or closes the contact's queued-or-live span; adjacent spans merge. */
function updateBusy(contact: ContactEvaluation, at: number): void {
  const busy = contact.active && contact.landed === null && (contact.queued !== null || contact.launched !== null);
  const last = contact.busySpans.at(-1);
  const open = last !== undefined && last.to === null;
  if (busy && !open) {
    if (last !== undefined && last.to === at) last.to = null;
    else contact.busySpans.push({ from: at, to: null });
  } else if (!busy && open) last.to = at;
}

function bucketAt(state: FoldEvaluation, at: number) {
  const hour = Math.floor(at / MS_PER_HOUR);
  let bucket = state.series.get(hour);
  if (!bucket) state.series.set(hour, bucket = { launches: 0, landAttempts: 0, conflicts: 0, reviewFailures: 0 });
  return bucket;
}

/** Keeps the latest `limit` distinct values, newest last. */
function noteLatest(list: string[], value: string, limit: number): void {
  const found = list.indexOf(value);
  if (found !== -1) list.splice(found, 1);
  else if (list.length === limit) list.shift();
  list.push(value);
}

function foldConflictPaths(state: FoldEvaluation, contact: ContactEvaluation, ticket: string, paths: readonly string[]): void {
  if (!paths.length) state.unpathedConflicts++;
  for (const path of new Set(paths)) {
    noteLatest(contact.conflictPaths, path, CONTACT_PATHS);
    let row = state.conflictPaths.get(path);
    if (!row) {
      if (state.conflictPaths.size === MAX_CONFLICT_PATHS) {
        state.droppedPaths++;
        continue;
      }
      state.conflictPaths.set(path, row = { conflicts: 0, contacts: [] });
    }
    row.conflicts++;
    noteLatest(row.contacts, ticket, PATH_CONTACTS);
  }
}

function foldOperatorEvent(contact: ContactEvaluation, event: OperatorEvent, at: number): void {
  const launching = event.op === "launch" || event.op === "relaunch";
  if (event.ok) {
    if (event.op === "approve") contact.gate = null;
    if (event.op === "resend") contact.resends++;
    // `op` is free text: an own-property check keeps `constructor` and friends out.
    if (Object.hasOwn(RESOLVES, event.op)) resolveWait(contact, RESOLVES[event.op]!, event.by === undefined ? "operator" : "automation", at);
    // The runner appends the action after its `launched`; only launches beyond the first are relaunches.
    const by = contact.relaunchBy;
    if (launching && contact.launches - 1 > by.operator + by.recovery + by.auto) {
      if (event.by === "recover") by.recovery++;
      else if (event.by === "auto") by.auto++;
      else by.operator++;
    }
    return;
  }
  if (!launching) return;
  // Error strings are `<code>: <message>` from the action runner, or recovery's own give-up record.
  const error = event.error ?? "";
  if (error.startsWith("memory-pressure:")) contact.refusals.memory++;
  else if (error.startsWith("refused: cap ")) contact.refusals.sessionCap++;
  else if (error.startsWith("refused:")) contact.refusals.refused++;
  else if (error.startsWith("gave up:")) contact.refusals.gaveUp++;
}

/** Legacy totals have no source ids; they cannot share the scoped source high-water marks. */
function attributeLegacyUsage(contact: ContactEvaluation, total: UsageTotals["tokens"], costUsd: number | null, suppress: boolean): void {
  const prior = contact.legacyTotals;
  const priorCost = contact.legacyCostUsd;
  // A drop in any counter means the session restarted; its delta is unknowable.
  if (prior !== null && !suppress && !TOKEN_KEYS.some(key => total[key] < prior[key])) {
    let tokenDelta = 0;
    for (const key of TOKEN_KEYS) tokenDelta += total[key] - prior[key];
    const costDelta = costUsd !== null && priorCost !== null ? costUsd - priorCost : 0;
    addPhaseSpend(contact, contact.phase ?? UNKNOWN_PHASE, tokenDelta, costDelta);
  }
  contact.legacyTotals = { ...total };
  contact.legacyCostUsd = costUsd;
}

/** Keeps the max seen per `role:id` source so contacts sharing a session never double-count it. */
function recordSourceHighWater(state: FoldEvaluation, value: UsageSource, contact: ContactEvaluation, ticket: string): void {
  const key = `${value.role}:${value.id}`;
  const seen = state.sources.get(key);
  if (!seen) {
    state.sources.set(key, { ...value, tokens: { ...value.tokens } });
    state.sourceOwners.set(key, ticket);
    return;
  }
  let reset = false;
  let tokenDelta = 0;
  const costDelta = value.costUsd !== null && seen.costUsd !== null ? Math.max(0, value.costUsd - seen.costUsd) : 0;
  for (const tokenKey of TOKEN_KEYS) {
    if (value.tokens[tokenKey] < seen.tokens[tokenKey]) reset = true;
    tokenDelta += Math.max(0, value.tokens[tokenKey] - seen.tokens[tokenKey]);
    seen.tokens[tokenKey] = Math.max(seen.tokens[tokenKey], value.tokens[tokenKey]);
  }
  if (value.costUsd !== null) {
    if (seen.costUsd !== null && value.costUsd < seen.costUsd) reset = true;
    seen.costUsd = Math.max(seen.costUsd ?? 0, value.costUsd);
  }
  // The first observer of a shared source delta owns its approximate phase attribution.
  if (!reset) addPhaseSpend(contact, contact.phase ?? UNKNOWN_PHASE, tokenDelta, costDelta);
  seen.sessions = Math.max(seen.sessions, value.sessions);
  seen.pricedMessages = Math.max(seen.pricedMessages, value.pricedMessages);
  seen.unpricedMessages = Math.max(seen.unpricedMessages, value.unpricedMessages);
  if (reset) state.resets++;
}

function foldPaneUsage(contact: ContactEvaluation, event: PaneUsageEvent): void {
  // Monotonic producer ids dedupe even when an old duplicate outlives the legacy-id ring.
  const parsed = /^pane:(0|[1-9][0-9]*)$/.test(event.pane) ? Number(event.pane.slice(5)) : null;
  const sequence = parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
  if (sequence !== null && sequence < contact.paneEvents) return;
  if (contact.paneIds.includes(event.pane)) return;
  if (contact.paneIds.length === PANE_ID_RING) contact.paneIds.shift();
  contact.paneIds.push(event.pane);
  contact.paneEvents = sequence !== null ? Math.max(contact.paneEvents + 1, sequence + 1) : contact.paneEvents + 1;

  const tokens = sumTokens(event.tokens);
  const malformedLines = event.malformedLines ?? 0;
  contact.paneTokens += tokens;
  contact.paneSessions += event.sessions;
  for (const key of TOKEN_KEYS) contact.paneEmittedTokens[key] += event.tokens[key];
  if (event.costUsd !== null) {
    contact.paneCostUsd = (contact.paneCostUsd ?? 0) + event.costUsd;
    contact.paneEmittedCostUsd += event.costUsd;
  }
  contact.paneMalformed += malformedLines;
  contact.paneTruncated ||= event.truncated === true;
  contact.phaseTokens[DECISION_PHASE] = (contact.phaseTokens[DECISION_PHASE] ?? 0) + tokens;
  if (event.costUsd !== null) contact.phaseCostUsd[DECISION_PHASE] = (contact.phaseCostUsd[DECISION_PHASE] ?? 0) + event.costUsd;
  contact.malformed += malformedLines;
  if (event.truncated || malformedLines > 0) contact.partial = true;
}

function foldMissionSample(contact: ContactEvaluation, mission: NonNullable<SampleEvent["mission"]>, at: number, index: number): void {
  if (contact.mission !== mission.id) {
    // A replaced run that was still partial leaves a permanent gap in what we know.
    if (contact.mission !== null && contact.partial) contact.unknown = true;
    contact.partial = contact.scoped;
    contact.hold = null;
    contact.latestRun = null;
    contact.completeAt = null;
    contact.readyRefs.length = 0;
    contact.legacyTotals = null;
    contact.legacyCostUsd = null;
  }
  if (contact.hold !== mission.hold && (contact.hold === "gate" || mission.hold === "gate")) pushRef(contact.gateRefs, index);
  if (mission.hold === "quota" && contact.hold !== "quota") contact.quotaEpisodes++;
  if (mission.complete && contact.completeAt === null) contact.readyRefs.push(index);
  if (!mission.complete) contact.readyRefs.length = 0;
  contact.mission = mission.id;
  contact.hold = mission.hold;
  contact.completeAt = mission.complete ? (contact.completeAt ?? at) : null;
}

function foldMeasurements(state: FoldEvaluation, contact: ContactEvaluation, ticket: string, measurements: Measurements, at: number, index: number): void {
  if (contact.mission === null) {
    contact.unknown = true;
    return;
  }
  const key = `${contact.mission}:${measurements.since}`;
  const previous = state.runs.get(key);
  const value = { ...measurements, severity: { ...measurements.severity }, config: { ...measurements.config } };
  if (previous) {
    for (const field of HISTORICAL_COUNTS) {
      if (value[field] < previous.measurements[field]) state.resets++;
      value[field] = Math.max(value[field], previous.measurements[field]);
    }
  }
  const before = previous?.measurements;
  const rounds = value.completedRounds - (before?.completedRounds ?? 0);
  if (rounds > 0) {
    if (contact.rounds.length === MAX_ROUNDS) contact.rounds.shift();
    contact.rounds.push({ at, rounds, findings: value.findingOccurrences - (before?.findingOccurrences ?? 0), actionable: value.latestActionable, rejected: value.latestRejected });
  }
  const reviewFailures = value.reviewFailures - (before?.reviewFailures ?? 0);
  if (reviewFailures > 0) bucketAt(state, at).reviewFailures += reviewFailures;
  const eventIndexes = previous?.eventIndexes ?? [];
  pushRef(eventIndexes, index);
  state.runs.set(key, { contact: ticket, missionId: contact.mission, measurements: value, eventIndexes });
  contact.latestRun = key;
  if (state.config.value === null) state.config.value = { ...value.config };
  else if (JSON.stringify(state.config.value) !== JSON.stringify(value.config)) state.config.mixed = true;
}

function foldUsageEvidence(state: FoldEvaluation, contact: ContactEvaluation, ticket: string, evidence: UsageEvidence): void {
  contact.scoped = true;
  contact.missing = evidence.missing;
  contact.unsupported = evidence.unsupportedWorkers;
  contact.malformed = Math.max(contact.malformed, evidence.malformedLines);
  contact.resets = Math.max(contact.resets, evidence.resets);
  contact.backlog = evidence.backlogBytes;
  contact.partial = evidence.partial || contact.malformed > 0 || contact.resets > 0;
  for (const source of evidence.sources) recordSourceHighWater(state, source, contact, ticket);
}

function foldSample(state: FoldEvaluation, contact: ContactEvaluation, event: SampleEvent, at: number, index: number): void {
  if (event.workers !== undefined && isNonnegative(event.workers)) contact.workerValue = event.workers;
  if (event.mission !== undefined) foldMissionSample(contact, event.mission, at, index);
  if (event.usage !== undefined) {
    // Once scoped evidence exists, legacy deltas would count the coordinator again.
    const scopedEvidence = contact.scoped || (event.usageEvidence !== undefined && event.usageEvidence !== null);
    contact.legacy = event.usage;
    attributeLegacyUsage(contact, event.usage.tokens, event.usage.costUsd, scopedEvidence);
  }
  if (event.measurements === null) contact.unknown = true;
  else if (event.measurements !== undefined) foldMeasurements(state, contact, event.contact, event.measurements, at, index);
  if (event.usageEvidence === null) contact.unknown = true;
  else if (event.usageEvidence !== undefined) foldUsageEvidence(state, contact, event.contact, event.usageEvidence);
  if (event.mission !== undefined || event.usage !== undefined || event.usageEvidence !== undefined || event.measurements === null) contact.usageRef = index;
}

export function foldEvaluation(state: FoldEvaluation, event: Event, index: number): void {
  if (state.closed !== null) return;
  const stamped = Date.parse(event.at);
  // Out-of-order stamps are clamped to the fold clock so no interval goes negative.
  const at = Math.max(state.clock ?? stamped, stamped);
  if (at !== stamped) state.anomalies++;
  if (state.clock !== null) state.connectedMs += (at - state.clock) * state.connected;
  state.clock = at;
  if (event.kind === "closed") {
    state.closed = at;
    for (const contact of Object.values(state.contacts)) {
      accrue(contact, at);
      contact.active = false;
      contact.ended ??= at;
      if (contact.landed === null) contact.endedBy ??= "closed";
      updateWait(contact, at);
      updateBusy(contact, at);
    }
    state.connected = 0;
    return;
  }
  if (!("contact" in event)) return;
  const contact = state.contacts[event.contact] ?? (state.contacts[event.contact] = newContact(at));
  accrue(contact, at);
  const disconnect = () => {
    if (contact.socket) state.connected--;
    contact.socket = false;
    contact.workerValue = null;
  };
  switch (event.kind) {
    case "queued":
      contact.queued ??= at;
      break;
    case "launched":
      contact.launched ??= at;
      contact.launches++;
      contact.active = contact.landed === null;
      contact.ended = null;
      contact.endedBy = null;
      contact.usageRef = index;
      pushRef(contact.launchRefs, index);
      bucketAt(state, at).launches++;
      break;
    case "landed":
      if (contact.landed === null && contact.completeAt !== null) contact.readyRefs.push(index);
      contact.landed ??= at;
      contact.ended = at;
      contact.active = false;
      disconnect();
      break;
    case "reaped":
    case "removed":
      contact.ended ??= at;
      if (contact.landed === null) contact.endedBy ??= event.kind;
      contact.active = false;
      disconnect();
      break;
    case "blocked":
      if (contact.blocked !== true) contact.blockedPost = contact.launched !== null;
      contact.blocked = true;
      contact.blockedBy = event.by ? [...event.by] : [];
      contact.blockedMs ??= 0;
      pushRef(contact.blockedRefs, index);
      break;
    case "unblocked":
      contact.blocked = false;
      contact.blockedBy = [];
      break;
    case "phase":
      if (contact.phase !== event.to) {
        contact.gate = null;
        contact.phase = event.to;
        contact.completeAt = event.to === "complete" ? at : null;
        contact.readyRefs.length = 0;
        if (contact.completeAt !== null) contact.readyRefs.push(index);
      }
      break;
    case "gate-armed":
      contact.gate = event.gate;
      contact.gateMs ??= 0;
      break;
    case "socket-up":
      state.connectivityFrom ??= at;
      if (contact.active && !contact.socket) {
        contact.socket = true;
        state.connected++;
        state.peak = Math.max(state.peak, state.connected);
      }
      contact.offline = false;
      break;
    case "socket-down":
      state.connectivityFrom ??= at;
      disconnect();
      if (!contact.offline) contact.offlineEpisodes++;
      contact.offline = true;
      contact.offlineMs ??= 0;
      break;
    case "launch-failed":
      contact.launchFailures++;
      break;
    case "land-attempt": {
      contact.landAttempts++;
      const bucket = bucketAt(state, at);
      bucket.landAttempts++;
      if (event.outcome === "conflict") {
        contact.conflicts++;
        bucket.conflicts++;
        if (state.conflicts.length === REF_RING) state.conflicts.shift();
        state.conflicts.push({ contact: event.contact, index });
        foldConflictPaths(state, contact, event.contact, event.paths ?? []);
      }
      break;
    }
    case "operator":
      foldOperatorEvent(contact, event, at);
      break;
    case "decided":
      resolveWait(contact, DECIDED, event.by === "operator" ? "operator" : "automation", at);
      break;
    case "pane-usage":
      foldPaneUsage(contact, event);
      break;
    case "sample":
      foldSample(state, contact, event, at, index);
      break;
  }
  updateWait(contact, at);
  updateBusy(contact, at);
}
