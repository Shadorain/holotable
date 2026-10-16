import { HOLDS, MODES, VERIFIES, type Derived, type Event, type Hold, type MeasurementConfig, type Measurements, type Operation, type SampleFields, type UsageEvidence, type UsageSource, type UsageTotals } from "./types.ts";

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
export interface ContactEvaluation {
  queued: number | null; launched: number | null; landed: number | null; ended: number | null;
  at: number; active: boolean; phase: string | null; gate: string | null; hold: Hold | null;
  blocked: boolean | null; socket: boolean; offline: boolean; workerValue: number | null;
  phaseMs: Record<string, number>; gateMs: number | null; offlineMs: number | null; blockedMs: number | null;
  holdMs: Partial<Record<Hold, number>>; workerMs: number; coveredMs: number; completeAt: number | null;
  launches: number; launchFailures: number; landAttempts: number; conflicts: number; resends: number;
  mission: string | null; latestRun: string | null; unknown: boolean; scoped: boolean;
  missing: number; unsupported: number; malformed: number; resets: number; backlog: number; partial: boolean;
  gateRefs:number[]; readyRefs:number[]; launchRefs:number[]; usageRef:number|null; legacy:SampleFields["usage"]|null;
  usageTotals:UsageTotals["tokens"]|null; usageCostUsd:number|null; phaseTokens:Record<string,number>; phaseCostUsd:Record<string,number>;
}
interface RunEvidence { contact: string; missionId: string; measurements: Measurements; eventIndexes: number[] }
export interface EvaluationEvidence {
  runs: RunEvidence[];
  contacts:Array<{ticket:string;lifetimeMs:number|null;gateHoldMs:number|null;finalReadyMs:number|null;gateEventIndexes:number[];deliveryEventIndexes:number[];launchEventIndexes:number[]}>;
  conflictEvents: Array<{ contact: string; index: number }>;
  usageEvents: Array<{ contact: string; index: number }>;
}
export interface FoldEvaluation {
  clock: number | null; closed: number | null; anomalies: number; resets: number;
  contacts: Record<string, ContactEvaluation>; runs: Map<string, RunEvidence>; sources: Map<string, UsageSource>;
  connected: number; peak: number; connectedMs: number; connectivityFrom: number | null;
  config: { value: MeasurementConfig | null; mixed: boolean };
  conflicts:Array<{contact:string;index:number}>;
}
const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export const MEASUREMENT_COUNTS = ["recordedPassed", "recordedFailed", "repeatedFailedRevision", "mergePreflightFailures", "boundaryFailures", "reviewFailures", "acceptedRepairs", "completedRounds", "invalidatedRounds", "findingOccurrences", "latestActionable", "latestRejected", "workerAttempts", "workerBeads", "repairRound", "repairLinks"] as const;
const HISTORICAL_COUNTS = ["recordedPassed", "recordedFailed", "repeatedFailedRevision", "mergePreflightFailures", "boundaryFailures", "reviewFailures", "acceptedRepairs", "completedRounds", "invalidatedRounds", "findingOccurrences"] as const;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => nonnegative(v) && Number.isSafeInteger(v);
const timestamp = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v));
const tokens = (): UsageTotals["tokens"] => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const severity = (): Measurements["severity"] => ({ critical: 0, high: 0, medium: 0, low: 0 });

export function parseMeasurementConfig(v: unknown): MeasurementConfig | null {
  if (!record(v) || typeof v.graph!=="string" || !["local", "beads"].includes(v.graph) || typeof v.frontend!=="string" || !["none", "orca", "herdr", "custom", "subagent"].includes(v.frontend) || !count(v.maxWorkers) || v.maxWorkers < 1 || v.maxWorkers > 64 || !count(v.reviewConcurrency) || v.reviewConcurrency < 1 || v.reviewConcurrency > 64 || !MODES.includes(v.mode as never)) return null;
  return { graph: v.graph as MeasurementConfig["graph"], frontend: v.frontend as MeasurementConfig["frontend"], maxWorkers: v.maxWorkers, reviewConcurrency: v.reviewConcurrency, mode: v.mode as MeasurementConfig["mode"] };
}
export function parseMeasurements(v: unknown): Measurements | null {
  if (!record(v) || v.v !== 1 || !timestamp(v.since) || !record(v.severity) || !MEASUREMENT_COUNTS.every(k => count(v[k])) || !SEVERITIES.every(k => count((v.severity as Record<string, unknown>)[k]))) return null;
  const config = parseMeasurementConfig(v.config);
  if (!config) return null;
  const result = { v: 1, since: v.since, severity: { critical:v.severity.critical, high:v.severity.high, medium:v.severity.medium, low:v.severity.low }, config } as Measurements;
  for (const key of MEASUREMENT_COUNTS) result[key] = v[key] as number;
  return result;
}
export function parseUsageEvidence(v: unknown): UsageEvidence | null {
  if (!record(v) || v.v !== 1 || !timestamp(v.measuredAt) || !Array.isArray(v.sources) || v.sources.length > 3 || typeof v.partial !== "boolean" || !["missing", "unsupportedWorkers", "malformedLines", "resets", "backlogBytes"].every(k => count(v[k]))) return null;
  const sources: UsageSource[] = [];
  const roles = new Set<string>();
  for (const raw of v.sources) {
    if (!record(raw) || typeof raw.role!=="string" || !["coordinator", "worker", "review"].includes(raw.role) || roles.has(raw.role) || typeof raw.id !== "string" || !raw.id || raw.id.length > 128 || !record(raw.tokens) || !TOKEN_KEYS.every(k => count((raw.tokens as Record<string, unknown>)[k])) || !(raw.costUsd === null || nonnegative(raw.costUsd)) || !["sessions", "pricedMessages", "unpricedMessages"].every(k => count(raw[k]))) return null;
    roles.add(raw.role);
    sources.push({ role: raw.role as UsageSource["role"], id: raw.id, tokens: { input: raw.tokens.input as number, output: raw.tokens.output as number, cacheRead: raw.tokens.cacheRead as number, cacheWrite: raw.tokens.cacheWrite as number }, costUsd: raw.costUsd as number | null, sessions: raw.sessions as number, pricedMessages: raw.pricedMessages as number, unpricedMessages: raw.unpricedMessages as number });
  }
  return { v: 1, measuredAt: v.measuredAt, sources, missing: v.missing as number, unsupportedWorkers: v.unsupportedWorkers as number, malformedLines: v.malformedLines as number, resets: v.resets as number, backlogBytes: v.backlogBytes as number, partial: v.partial };
}
export function createFoldEvaluation(): FoldEvaluation {
  return { clock: null, closed: null, anomalies: 0, resets: 0, contacts: Object.create(null), runs: new Map(), sources: new Map(), connected: 0, peak: 0, connectedMs: 0, connectivityFrom: null, config: { value: null, mixed: false }, conflicts: [] };
}
function newContact(at: number): ContactEvaluation {
  return { queued: null, launched: null, landed: null, ended: null, at, active: true, phase: null, gate: null, hold: null, blocked: null, socket: false, offline: false, workerValue: null, phaseMs: Object.create(null), gateMs: null, offlineMs: null, blockedMs: null, holdMs: {}, workerMs: 0, coveredMs: 0, completeAt: null, launches: 0, launchFailures: 0, landAttempts: 0, conflicts: 0, resends: 0, mission: null, latestRun: null, unknown: false, scoped: false, missing: 0, unsupported: 0, malformed: 0, resets: 0, backlog: 0, partial: false, gateRefs:[],readyRefs:[],launchRefs:[],usageRef:null,legacy:null,usageTotals:null,usageCostUsd:null,phaseTokens:{},phaseCostUsd:{} };
}
function accrue(c: ContactEvaluation, at: number): void {
  const dt = Math.max(0, at - c.at);
  if (c.active) {
    if (c.phase !== null) c.phaseMs[c.phase] = (c.phaseMs[c.phase] ?? 0) + dt;
    if (c.gate !== null) c.gateMs = (c.gateMs ?? 0) + dt;
    if (c.offline) c.offlineMs = (c.offlineMs ?? 0) + dt;
    if (c.blocked && c.launched === null) c.blockedMs = (c.blockedMs ?? 0) + dt;
    if (c.hold !== null && c.hold !== "none") c.holdMs[c.hold] = (c.holdMs[c.hold] ?? 0) + dt;
    if (c.socket && c.workerValue !== null) { c.coveredMs += dt; c.workerMs += dt * c.workerValue; }
  }

  c.at = at;
}
/** Attribute a usage delta to the phase active at sample time; a total drop rebases without attributing. */
function attributeUsage(c: ContactEvaluation, total: UsageTotals["tokens"], costUsd: number | null): void {
  const phase = c.phase ?? "unknown";
  if (c.usageTotals !== null) {
    const dropped = TOKEN_KEYS.some(k => total[k] < c.usageTotals![k]);
    if (!dropped) {
      let dt = 0;
      for (const k of TOKEN_KEYS) dt += total[k] - c.usageTotals[k];
      if (dt > 0) c.phaseTokens[phase] = (c.phaseTokens[phase] ?? 0) + dt;
      if (costUsd !== null && c.usageCostUsd !== null && costUsd > c.usageCostUsd)
        c.phaseCostUsd[phase] = (c.phaseCostUsd[phase] ?? 0) + (costUsd - c.usageCostUsd);
    }
  }
  c.usageTotals = { ...total };
  c.usageCostUsd = costUsd;
}
function sourceHighWater(s: FoldEvaluation, value: UsageSource): void {
  const key = `${value.role}:${value.id}`;
  const old = s.sources.get(key);
  if (!old) { s.sources.set(key, { ...value, tokens: { ...value.tokens } }); return; }
  let reset = false;
  for (const k of TOKEN_KEYS) { if (value.tokens[k] < old.tokens[k]) reset = true; old.tokens[k] = Math.max(old.tokens[k], value.tokens[k]); }
  if (value.costUsd !== null) { if (old.costUsd !== null && value.costUsd < old.costUsd) reset = true; old.costUsd = Math.max(old.costUsd ?? 0, value.costUsd); }
  old.sessions = Math.max(old.sessions, value.sessions);
  old.pricedMessages = Math.max(old.pricedMessages, value.pricedMessages);
  old.unpricedMessages = Math.max(old.unpricedMessages, value.unpricedMessages);
  if (reset) s.resets++;
}
export function foldEvaluation(s: FoldEvaluation, e: Event, index: number): void {
  if (s.closed !== null) return;
  const raw = Date.parse(e.at);
  const at = Math.max(s.clock ?? raw, raw);
  if (at !== raw) s.anomalies++;
  if (s.clock !== null) s.connectedMs += (at - s.clock) * s.connected;
  s.clock = at;
  if (e.kind === "closed") { s.closed = at; for (const c of Object.values(s.contacts)) { accrue(c, at); c.active = false; c.ended ??= at; } s.connected = 0; return; }
  if (!("contact" in e)) return;
  const c = s.contacts[e.contact] ?? (s.contacts[e.contact] = newContact(at));
  accrue(c, at);
  const disconnect = () => { if (c.socket) s.connected--; c.socket = false; c.workerValue = null; };
  switch (e.kind) {
    case "queued": c.queued ??= at; break;
    case "launched": c.launched??=at;c.launches++;c.active=c.landed===null;c.ended=null;c.usageRef=index;if(c.launchRefs.length===3)c.launchRefs.shift();c.launchRefs.push(index);break;
    case "landed":
      if(c.landed===null&&c.completeAt!==null)c.readyRefs.push(index);
      c.landed??=at;c.ended=at;c.active=false;disconnect();break;
    case "reaped": case "removed": c.ended ??= at; c.active = false; disconnect(); break;
    case "blocked": c.blocked = true; c.blockedMs ??= 0; break;
    case "unblocked": c.blocked = false; break;
    case "phase":
      if(c.phase!==e.to){c.gate=null;c.phase=e.to;c.completeAt=e.to==="complete"?at:null;c.readyRefs.length=0;if(c.completeAt!==null)c.readyRefs.push(index);}
      break;
    case "gate-armed": c.gate = e.gate; c.gateMs ??= 0; break;
    case "socket-up":
      s.connectivityFrom ??= at;
      if (c.active && !c.socket) { c.socket = true; s.connected++; s.peak = Math.max(s.peak, s.connected); }
      c.offline = false; break;
    case "socket-down": s.connectivityFrom ??= at; disconnect(); c.offline = true; c.offlineMs ??= 0; break;
    case "launch-failed": c.launchFailures++; break;
    case "land-attempt": c.landAttempts++; if (e.outcome === "conflict") { c.conflicts++; if (s.conflicts.length < 3) s.conflicts.push({ contact: e.contact, index }); } break;
    case "operator": if (e.ok && e.op === "approve") c.gate = null; if (e.ok && e.op === "resend") c.resends++; break;
    case "sample": {
      if (e.workers !== undefined && nonnegative(e.workers)) c.workerValue = e.workers;
      if (e.usage !== undefined) { c.legacy = e.usage; attributeUsage(c, e.usage.tokens, e.usage.costUsd); }
      if (e.mission !== undefined) {
        if(c.mission!==e.mission.id){
          if(c.mission!==null&&c.partial)c.unknown=true;
          c.partial=c.scoped;c.hold=null;c.latestRun=null;c.completeAt=null;c.readyRefs.length=0;c.usageTotals=null;c.usageCostUsd=null;c.phaseTokens={};c.phaseCostUsd={};
        }
        if(c.hold!==e.mission.hold&&(c.hold==="gate"||e.mission.hold==="gate")){
          if(c.gateRefs.length===3)c.gateRefs.shift();c.gateRefs.push(index);
        }
        if(e.mission.complete&&c.completeAt===null)c.readyRefs.push(index);
        if(!e.mission.complete)c.readyRefs.length=0;
        c.mission = e.mission.id; c.hold = e.mission.hold;
        c.completeAt=e.mission.complete?(c.completeAt??at):null;
      }
      if (e.measurements !== undefined) {
        if (e.measurements === null || c.mission === null) c.unknown = true;
        else {
          const key = `${c.mission}:${e.measurements.since}`;
          const old = s.runs.get(key);
          const value = { ...e.measurements, severity: { ...e.measurements.severity }, config: { ...e.measurements.config } };
          if (old) for (const k of HISTORICAL_COUNTS) { if (value[k] < old.measurements[k]) s.resets++; value[k] = Math.max(value[k], old.measurements[k]); }
          const refs=old?.eventIndexes??[];
          if(refs.length===3)refs.shift();refs.push(index);
          s.runs.set(key,{contact:e.contact,missionId:c.mission,measurements:value,eventIndexes:refs});
          c.latestRun = key;
          if (s.config.value === null) s.config.value = { ...value.config };
          else if (JSON.stringify(s.config.value) !== JSON.stringify(value.config)) s.config.mixed = true;
        }
      }
      if (e.usageEvidence !== undefined) {
        if (e.usageEvidence === null) c.unknown = true;
        else {
          const u = e.usageEvidence;
          c.scoped=true;c.missing=u.missing;c.unsupported=u.unsupportedWorkers;
          c.malformed = Math.max(c.malformed, u.malformedLines); c.resets = Math.max(c.resets, u.resets); c.backlog = u.backlogBytes;
          c.partial=u.partial||c.malformed>0||c.resets>0;
          for (const source of u.sources) sourceHighWater(s, source);
          const total = tokens(); let costUsd: number | null = null;
          for (const source of u.sources) {
            for (const k of TOKEN_KEYS) total[k] += source.tokens[k];
            if (source.costUsd !== null) costUsd = (costUsd ?? 0) + source.costUsd;
          }
          attributeUsage(c, total, costUsd);
        }
      }
      if(e.mission!==undefined||e.usage!==undefined||e.usageEvidence!==undefined||e.measurements===null)c.usageRef=index;
      break;
    }
  }
}
export function distribution(values: number[]): Distribution {
  values.sort((a, b) => a - b);
  const n = values.length;
  return { n, medianMs: n ? n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2 : null, p90Ms: n ? values[Math.ceil(n * .9) - 1] : null };
}
function age(): AgeSummary { return { n: 0, totalMs: 0, maxMs: null }; }
function addAge(a: AgeSummary, value: number): void { a.n++; a.totalMs += value; a.maxMs = Math.max(a.maxMs ?? 0, value); }
export function evaluateOperation(operation: Operation, derived: Derived, now: number): Evaluation {
  const s = derived.evaluation ?? createFoldEvaluation();
  const clock = s.closed ?? Math.max(now, s.clock ?? now);
  const elapsed = Math.max(0, clock - Date.parse(operation.createdAt));
  const result: Evaluation = {
    v: 1, asOf: clock, deliveredWork: 0, throughputPerHour: null,
    queue: distribution([]), queued: age(), delivery: distribution([]), lead: distribution([]), unfinished: age(),
    dependencyWaitMs: null, phaseMs: Object.create(null), gateWaitMs: null, offlineMs: null, deliveryReadyMs: null, holdMs: {},
    connectivity: { observedMs: s.connectivityFrom === null ? 0 : Math.max(0, clock - s.connectivityFrom), connectedContactMs: s.connectedMs + Math.max(0, clock - (s.clock ?? clock)) * s.connected, peak: s.peak, mean: null },
    workers: { coveredMs: 0, nonclosedWorkerMs: 0 }, attempts: { launches: 0, relaunches: 0, launchFailures: 0, landAttempts: 0, conflicts: 0 },
    fleet: { workerAttempts: null, workerBeads: null, redispatches: null, repairRound: null, repairLinks: null, boardResendRequests: 0 },
    usage: { basis: "missing", tokens: null, knownCostUsd: null, costPerDelivered: null, missingSources: 0, unsupportedWorkers: 0, pricedMessages: 0, unpricedMessages: 0, malformedLines: 0, resets: 0, backlogBytes: 0, coordinatorSessionAssociated: false, partial: false },
    quality: null, config: { value: s.config.value, mixed: s.config.mixed }, coverage: { timed: 0, launched: 0, usageReported: 0, legacyUsage: 0, producerEvidence: s.runs.size, clockAnomalies: s.anomalies, counterResets: s.resets }, recommendations: [],
  };
  const queue: number[] = [], delivery: number[] = [], lead: number[] = [];
  let scoped = 0, legacy = 0;
  for (const contact of operation.contacts) {
    const original = s.contacts[contact.ticket];
    if (!original) continue;
    const c = { ...original, phaseMs: { ...original.phaseMs }, holdMs: { ...original.holdMs } };
    accrue(c, clock);
    const end = c.landed ?? c.ended ?? clock;
    const work = contact.kind === "implement" || contact.kind === "audit";
    if (work) {
      if (c.queued !== null && c.launched !== null) queue.push(Math.max(0, c.launched - c.queued));
      else if (c.queued !== null && c.landed === null) addAge(result.queued, Math.max(0, end - c.queued));
      if (c.landed !== null) {
        result.deliveredWork++;
        if (c.launched !== null) delivery.push(Math.max(0, c.landed - c.launched));
        if (c.queued !== null) lead.push(Math.max(0, c.landed - c.queued));
        if (c.completeAt !== null) result.deliveryReadyMs = (result.deliveryReadyMs ?? 0) + Math.max(0, c.landed - c.completeAt);
      } else if (c.launched !== null) addAge(result.unfinished, Math.max(0, end - c.launched));
    }
    if (c.launched !== null) result.coverage.launched++;
    if (c.queued !== null || c.launched !== null) result.coverage.timed++;
    for (const [phase, value] of Object.entries(c.phaseMs)) result.phaseMs[phase] = (result.phaseMs[phase] ?? 0) + value;
    for (const h of HOLDS) if (c.holdMs[h] !== undefined) result.holdMs[h] = (result.holdMs[h] ?? 0) + c.holdMs[h]!;
    if (c.blockedMs !== null) result.dependencyWaitMs = (result.dependencyWaitMs ?? 0) + c.blockedMs;
    if (c.gateMs !== null) result.gateWaitMs = (result.gateWaitMs ?? 0) + c.gateMs;
    if (c.offlineMs !== null) result.offlineMs = (result.offlineMs ?? 0) + c.offlineMs;
    result.workers.coveredMs += c.coveredMs; result.workers.nonclosedWorkerMs += c.workerMs;
    result.attempts.launches += c.launches; result.attempts.relaunches += Math.max(0, c.launches - 1);
    result.attempts.launchFailures += c.launchFailures; result.attempts.landAttempts += c.landAttempts; result.attempts.conflicts += c.conflicts;
    result.fleet.boardResendRequests += c.resends;
    result.usage.missingSources += c.missing; result.usage.unsupportedWorkers += c.unsupported;
    const byPhase = result.usage.byPhase ?? (result.usage.byPhase = Object.create(null));
    for (const [phase, t] of Object.entries(c.phaseTokens)) {
      const row = byPhase[phase] ?? (byPhase[phase] = { tokens: 0, costUsd: null });
      row.tokens += t;
    }
    for (const [phase, cost] of Object.entries(c.phaseCostUsd)) {
      const row = byPhase[phase] ?? (byPhase[phase] = { tokens: 0, costUsd: null });
      row.costUsd = (row.costUsd ?? 0) + cost;
    }
    if (!Object.keys(byPhase).length) result.usage.byPhase = undefined;
    result.usage.malformedLines += c.malformed; result.usage.resets += c.resets; result.usage.backlogBytes += c.backlog;
    result.usage.partial ||= c.partial || c.unknown;
    if (c.scoped) { scoped++; result.coverage.usageReported++; }
    else if (c.legacy) {
      legacy++; result.coverage.usageReported++;
      if (TOKEN_KEYS.every(k => nonnegative(c.legacy!.tokens[k]))) {
        result.usage.tokens ??= tokens(); for (const k of TOKEN_KEYS) result.usage.tokens[k] += c.legacy.tokens[k];
      }
      if (nonnegative(c.legacy.costUsd)) result.usage.knownCostUsd = (result.usage.knownCostUsd ?? 0) + c.legacy.costUsd;
      result.usage.partial = true;
    } else if (c.launched !== null) { result.usage.missingSources++; result.usage.partial = true; }
  }
  for (const source of s.sources.values()) {
    result.usage.tokens ??= tokens(); for (const k of TOKEN_KEYS) result.usage.tokens[k] += source.tokens[k];
    if (source.costUsd !== null) result.usage.knownCostUsd = (result.usage.knownCostUsd ?? 0) + source.costUsd;
    result.usage.pricedMessages! += source.pricedMessages; result.usage.unpricedMessages! += source.unpricedMessages;
    if (source.role === "coordinator") result.usage.coordinatorSessionAssociated = true;
  }
  result.coverage.legacyUsage = legacy;
  result.usage.basis = scoped ? legacy ? "mixed" : "scoped" : legacy ? "legacy" : "missing";
  if (legacy) { result.usage.pricedMessages = null; result.usage.unpricedMessages = null; }
  result.usage.partial ||= result.usage.resets > 0 || s.resets > 0 || (result.usage.unpricedMessages ?? 0) > 0;
  result.queue = distribution(queue); result.delivery = distribution(delivery); result.lead = distribution(lead);
  result.throughputPerHour = elapsed > 0 ? result.deliveredWork * 3_600_000 / elapsed : null;
  result.connectivity.mean = result.connectivity.observedMs ? result.connectivity.connectedContactMs / result.connectivity.observedMs : null;
  result.usage.costPerDelivered = result.deliveredWork > 0 && result.usage.knownCostUsd !== null ? result.usage.knownCostUsd / result.deliveredWork : null;
  for (const [key, run] of s.runs) {
    const m = run.measurements;
    result.quality ??= { since: m.since, recordedPassed: 0, recordedFailed: 0, repeatedFailedRevision: 0, mergePreflightFailures: 0, boundaryFailures: 0, reviewFailures: 0, acceptedRepairs: 0, completedRounds: 0, invalidatedRounds: 0, findingOccurrences: 0, latestActionable: 0, latestRejected: 0, severity: severity() };
    if (m.since < result.quality.since) result.quality.since = m.since;
    for (const field of HISTORICAL_COUNTS) result.quality[field] += m[field];
    result.fleet.workerAttempts = (result.fleet.workerAttempts ?? 0) + m.workerAttempts;
    result.fleet.workerBeads = (result.fleet.workerBeads ?? 0) + m.workerBeads;
    result.fleet.redispatches = (result.fleet.redispatches ?? 0) + Math.max(0, m.workerAttempts - m.workerBeads);
    result.fleet.repairRound = Math.max(result.fleet.repairRound ?? 0, m.repairRound);
    if (s.contacts[run.contact]?.latestRun === key) {
      result.fleet.repairLinks = (result.fleet.repairLinks ?? 0) + m.repairLinks;
      result.quality.latestActionable += m.latestActionable; result.quality.latestRejected += m.latestRejected;
      for (const k of SEVERITIES) result.quality.severity[k] += m.severity[k];
    }
  }
  result.recommendations=recommendEvaluation(result,evaluationEvidence(operation,derived,clock),{autoLand:operation.auto?.enabled===true&&operation.auto.land===true});
  return result;
}

export function evaluationEvidence(operation:Operation,derived:Derived,now:number):EvaluationEvidence {
  const s=derived.evaluation??createFoldEvaluation(),clock=s.closed??Math.max(now,s.clock??now);
  const usageEvents:Array<{contact:string;index:number}>=[];
  const contacts=operation.contacts.map(contact=>{
    const c=s.contacts[contact.ticket],dt=c?.active?Math.max(0,clock-c.at):0;
    if(c?.usageRef!==null&&c?.usageRef!==undefined&&(c.partial||c.unknown||!c.scoped)&&usageEvents.length<3)usageEvents.push({contact:contact.ticket,index:c.usageRef});
    return {ticket:contact.ticket,lifetimeMs:!c||c.launched===null?null:Math.max(0,(c.landed??c.ended??clock)-c.launched),gateHoldMs:c?.holdMs.gate===undefined&&c?.hold!=="gate"?null:(c?.holdMs.gate??0)+(c?.hold==="gate"?dt:0),finalReadyMs:c?.completeAt!==null&&c?.completeAt!==undefined&&c.landed!==null&&(contact.kind==="implement"||contact.kind==="audit")?Math.max(0,c.landed-c.completeAt):null,gateEventIndexes:c?.gateRefs??[],deliveryEventIndexes:c?.readyRefs??[],launchEventIndexes:c?.launchRefs??[]};
  });
  if(!usageEvents.length)for(const contact of operation.contacts){const index=s.contacts[contact.ticket]?.usageRef;if(index!==null&&index!==undefined&&usageEvents.length<3)usageEvents.push({contact:contact.ticket,index});}
  return {runs:[...s.runs.values()],contacts,conflictEvents:s.conflicts,usageEvents};
}

export function recommendEvaluation(e:Evaluation,proof:EvaluationEvidence,opts:{autoLand?:boolean}={}):Recommendation[] {
  const out:Recommendation[]=[];
  const add=(id:string,level:Recommendation["level"],message:string,numerator:number,denominator:number|null,observedMs:number|null,rows:Array<{contact:string;index:number}>,caveat:string)=>out.push({id,ruleVersion:1,level,message,evidence:{numerator,denominator,observedMs,contacts:[...new Set(rows.map(r=>r.contact))].sort().slice(0,3),eventIndexes:rows.slice(0,3).map(r=>r.index)},caveat});
  if(e.coverage.launched&&(e.usage.partial||e.coverage.legacyUsage||e.usage.backlogBytes)){
    const u=e.usage;
    add("usage-coverage","info","Inspect accounting coverage before comparing costs.",e.coverage.usageReported,e.coverage.launched,null,proof.usageEvents,`${u.missingSources} missing, ${u.unsupportedWorkers} unsupported; ${u.unpricedMessages??"unknown"} unpriced messages; ${u.malformedLines} malformed lines; ${u.resets+e.coverage.counterResets} reset observations; ${u.backlogBytes} backlog bytes. Historical gaps and associated sessions prevent exclusive mission billing.`);
  }
  let repeat:RunEvidence|undefined,review:RunEvidence|undefined;
  for(const run of proof.runs){
    if(!repeat||run.measurements.repeatedFailedRevision>repeat.measurements.repeatedFailedRevision||(run.measurements.repeatedFailedRevision===repeat.measurements.repeatedFailedRevision&&`${run.contact}:${run.missionId}`<`${repeat.contact}:${repeat.missionId}`))repeat=run;
    if(!review||run.measurements.reviewFailures>review.measurements.reviewFailures||(run.measurements.reviewFailures===review.measurements.reviewFailures&&`${run.contact}:${run.missionId}`<`${review.contact}:${review.missionId}`))review=run;
  }
  if(repeat&&repeat.measurements.repeatedFailedRevision>=2)add("repeat-verification","warning","Inspect repeated verification evidence and repair scope.",repeat.measurements.repeatedFailedRevision,repeat.measurements.recordedFailed,null,repeat.eventIndexes.map(index=>({contact:repeat.contact,index})),"Consecutive failed records share a fingerprint, not necessarily a root cause.");
  if(review&&review.measurements.reviewFailures>=3)add("review-retries","warning","Inspect reviewer failure evidence, provider capacity and revision churn.",review.measurements.reviewFailures,null,null,review.eventIndexes.map(index=>({contact:review.contact,index})),"Failed review operations are not completed rounds or proof of defects.");
  if(out.length===3)return out;
  if(e.attempts.landAttempts>=5&&e.attempts.conflicts>=2&&e.attempts.conflicts/e.attempts.landAttempts>=.3)add("integration-conflicts","warning","Inspect shared paths and delivery ordering before increasing parallelism.",e.attempts.conflicts,e.attempts.landAttempts,null,proof.conflictEvents,"Observed conflicts do not establish concurrency as their cause.");
  if(e.attempts.launches>=10&&e.attempts.relaunches>=5&&e.attempts.relaunches/e.attempts.launches>=.4)add("relaunch-churn","warning","Inspect relaunch causes before assuming restarts are routine.",e.attempts.relaunches,e.attempts.launches,null,proof.contacts.flatMap(c=>c.launchEventIndexes.map(index=>({contact:c.ticket,index}))),"Recorded relaunches include deliberate operator relaunches; churn does not prove pane death or wasted execution.");
  if(out.length===3)return out;
  const gates=proof.contacts.filter(c=>c.gateHoldMs!==null&&c.gateHoldMs>0&&c.lifetimeMs!==null);
  const gateMs=gates.reduce((n,c)=>n+c.gateHoldMs!,0),timed=proof.contacts.filter(c=>c.lifetimeMs!==null),life=timed.reduce((n,c)=>n+c.lifetimeMs!,0);
  if(gates.length>=3&&gateMs>=600_000&&life>0&&gateMs/life>=.3)add("approval-wait","info","Review approval availability and batching without bypassing gates.",gates.length,timed.length,gateMs,gates.flatMap(c=>c.gateEventIndexes.map(index=>({contact:c.ticket,index}))),"Observed hold time overlaps phase time and is not exclusive human response time.");
  if(out.length===3)return out;
  const ready=proof.contacts.filter(c=>c.finalReadyMs!==null),median=distribution(ready.map(c=>c.finalReadyMs!)).medianMs;
  if(ready.length>=3&&median!==null&&median>=600_000)add("delivery-wait","info",opts.autoLand===false?"Ready work is waiting on an operator Land click; enable auto.land or inspect delivery checks.":"Inspect delivery checks and integration availability.",ready.length,e.deliveredWork,median,ready.flatMap(c=>c.deliveryEventIndexes.map(index=>({contact:c.ticket,index}))),"Observed ready-to-land delay does not establish which delivery dependency caused it.");
  return out;
}

export function parseEvaluation(value: unknown): Evaluation | null {
  if (!record(value) || value.v !== 1 || !nonnegative(value.asOf)) return null;
  const nullable = (v: unknown) => v === null || nonnegative(v);
  const fields = ["deliveredWork", "asOf"];
  if (!fields.every(k => nonnegative(value[k])) || !["throughputPerHour", "dependencyWaitMs", "gateWaitMs", "offlineMs", "deliveryReadyMs"].every(k => nullable(value[k]))) return null;
  for (const key of ["queue", "delivery", "lead"]) { const v = value[key]; if (!record(v) || !count(v.n) || !nullable(v.medianMs) || !nullable(v.p90Ms)) return null; }
  for (const key of ["queued", "unfinished"]) { const v = value[key]; if (!record(v) || !count(v.n) || !nonnegative(v.totalMs) || !nullable(v.maxMs)) return null; }
  for (const key of ["phaseMs", "holdMs"]) if (!record(value[key]) || !Object.values(value[key] as object).every(nonnegative)) return null;
  const requiredCounts: Record<string, string[]> = {
    attempts: ["launches", "relaunches", "launchFailures", "landAttempts", "conflicts"],
    coverage: ["timed", "launched", "usageReported", "legacyUsage", "producerEvidence", "clockAnomalies", "counterResets"],
    workers: ["coveredMs", "nonclosedWorkerMs"],
  };
  for (const [key, fields] of Object.entries(requiredCounts)) if (!record(value[key]) || !fields.every(field => nonnegative((value[key] as Record<string, unknown>)[field]))) return null;
  if (!record(value.connectivity) || !["observedMs", "connectedContactMs", "peak"].every(k => nonnegative((value.connectivity as Record<string, unknown>)[k])) || !nullable(value.connectivity.mean)) return null;
  if (!record(value.fleet) || !["workerAttempts", "workerBeads", "redispatches", "repairRound", "repairLinks", "boardResendRequests"].every(k => nullable((value.fleet as Record<string, unknown>)[k]))) return null;
  const u = value.usage;
  if (!record(u) || typeof u.basis!=="string" || !["legacy", "scoped", "mixed", "missing"].includes(u.basis) || typeof u.partial !== "boolean" || typeof u.coordinatorSessionAssociated !== "boolean" || !["knownCostUsd", "costPerDelivered", "pricedMessages", "unpricedMessages"].every(k => nullable(u[k])) || !["missingSources", "unsupportedWorkers", "malformedLines", "resets", "backlogBytes"].every(k => count(u[k])) || !(u.tokens === null || record(u.tokens) && TOKEN_KEYS.every(k => nonnegative((u.tokens as Record<string, unknown>)[k])))) return null;
  if (u.byPhase !== undefined && (!record(u.byPhase) || !Object.values(u.byPhase).every(v => record(v) && nonnegative(v.tokens) && nullable(v.costUsd)))) return null;
  if (!record(value.config) || typeof value.config.mixed !== "boolean" || !(value.config.value === null || parseMeasurementConfig(value.config.value))) return null;
  const q = value.quality;
  if (q !== null && (!record(q) || !timestamp(q.since) || ![...HISTORICAL_COUNTS, "latestActionable", "latestRejected"].every(k => count(q[k])) || !record(q.severity) || !SEVERITIES.every(k => count((q.severity as Record<string, unknown>)[k])))) return null;
  if (!Array.isArray(value.recommendations) || value.recommendations.length > 3) return null;
  for (const r of value.recommendations) {
    if (!record(r) || r.ruleVersion !== 1 || typeof r.id !== "string" || typeof r.message !== "string" || typeof r.caveat !== "string" || typeof r.level!=="string" || !["info", "warning"].includes(r.level) || !record(r.evidence) || !nonnegative(r.evidence.numerator) || !nullable(r.evidence.denominator) || !nullable(r.evidence.observedMs) || !Array.isArray(r.evidence.contacts) || r.evidence.contacts.length > 3 || !r.evidence.contacts.every((v: unknown) => typeof v === "string") || !Array.isArray(r.evidence.eventIndexes) || r.evidence.eventIndexes.length > 3 || !r.evidence.eventIndexes.every(count)) return null;
  }
  return value as unknown as Evaluation;
}
