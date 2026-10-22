import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { holdsSlot } from "../core/fold.ts";
import { contactOf } from "../core/projection.ts";
import { unmetBlockers } from "../core/graph.ts";
import { trackerTicket } from "../core/validate-operation.ts";
import { messageOf } from "../core/errors.ts";
import { validateEvent } from "../core/validate-event.ts";
import { hasRecentUncontrolledStatus } from "../core/policy.ts";
import type {
  Contact,
  ContactDerived,
  Derived,
  ContactStatus,
  DeliveryProbe,
  Event,
  Load,
  MissionReport,
  Operation,
  Owner,
  SampleFields,
  Settings,
} from "../core/types.ts";
import type { ListedTerminal, Ports, Run } from "../ports.ts";
import type { ProjectionExtras } from "../snapshot.ts";
import { appendEvent, readFolded } from "../store/events.ts";
import { decisionsDir, listDecisionPanes, readDecisionDoc, readDecisionPane, removeDecisionPane, validateDecision, writeDecisionPane } from "../store/decisions.ts";
import { summarizePaneSessions } from "../store/pane-usage.ts";
import { saveContactReport } from "../store/reports.ts";
import { listOperations, readOperation } from "../store/operations.ts";
import { notifyChanged } from "../core/notify.ts";

export interface WatcherDeps {
  home: string;
  now(): Date;
  settings(): Promise<Settings>;
  portsFor(operation: Operation, settings: Settings): Ports;
  /** Port failures and similar; the watcher never throws out of a pass. */
  warn(message: string): void;
  /** Shell for the integration dirtiness probe; absent leaves integrationDirty null. */
  run?: Run;
}

/** What the watcher has already written for a contact, so a restart or a repeated pass emits nothing twice. */
interface Seen {
  phase: string | null;
  gate: string | null;
  up: boolean;
  generation: number | null;
  sample: Partial<Record<keyof SampleFields, string>>;
  missionId: string | null;
  /** Last blocked/unblocked event: true while the queue shows this contact as blocked. */
  blocked: boolean;
}
interface OpState {
  statuses: Record<string, ContactStatus | null>;
  owners: Record<string, Owner>;
  probes: Record<string, DeliveryProbe | null>;
  lastSampleAt: number;
  open: number;
  /** Launched contacts whose terminal the frontend no longer lists (as of the last pass). */
  vanished: Set<string>;
  /** Status files whose recorded process provably exited (pid reuse beats staleness). */
  gone: Set<string>;
  /** Decision contacts with an open agent pane (decisions/<ticket>.pane.json on disk). */
  decisionPanes: Set<string>;
  /** Uncommitted path count in the integration checkout; null until probed or not a local-merge op. */
  integrationDirty: number | null;
  /** Serialized extras after the last pass; a change is pushed to stream clients. */
  fp: string;
  /** Signature per .sessions dir; an unchanged dir skips re-parsing its transcripts. */
  paneSigs: Map<string, string>;
  /** Serialized report last saved per ticket, so an unchanged report costs no file read. */
  reports: Record<string, string>;
}

function newOpState(): OpState {
  return {
    statuses: {},
    owners: {},
    probes: {},
    lastSampleAt: 0,
    open: 0,
    vanished: new Set(),
    gone: new Set(),
    decisionPanes: new Set(),
    integrationDirty: null,
    fp: "",
    paneSigs: new Map(),
    reports: {},
  };
}

const GLOBAL_FRONTENDS: Record<string, true> = { orca: true, herdr: true };

/** Terminal listing is skipped unless at least one non-landed/non-reaped contact has a recorded terminal or decisionPanes is nonempty. */
function needsTerminalList(op: Operation, folded: Derived, state: OpState): boolean {
  if (state.decisionPanes.size > 0) return true;
  return op.contacts.some((contact) => {
    const terminal = contact.lane?.terminal;
    if (!terminal) return false;
    const d = folded.contacts[contact.ticket];
    return !d?.reaped && !d?.landed;
  });
}

/** Clear stale vanished state for contacts that have landed, reaped, or no longer have a terminal. */
function clearStaleVanished(op: Operation, folded: Derived, state: OpState): void {
  for (const ticket of state.vanished) {
    const contact = contactOf(op, ticket);
    const d = folded.contacts[ticket];
    if (!contact?.lane?.terminal || d?.landed || d?.reaped) {
      state.vanished.delete(ticket);
    }
  }
}

/** Panes whose omp can still be running: open decision panes and contact panes that hold a slot. */
function openCount(op: Operation, folded: Derived, state: OpState): number {
  let n = state.decisionPanes.size;
  for (const contact of op.contacts) {
    if (holdsSlot(contact, folded, state.owners[contact.ticket], state.vanished.has(contact.ticket))) n += 1;
  }
  return n;
}

const SAMPLE_GROUPS = ["tracker", "delivery", "workers", "omp", "usage", "mission", "measurements", "usageEvidence"] as const;

/** JSON with object keys sorted, so property order never reads as a change. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Comparison key for one sample group; an unchanged key emits no new `sample`. Every field of the group
 * counts, so a field a producer adds is watched without listing it here. The exceptions are
 * usageEvidence.measuredAt, which moves on every read, and the order of usageEvidence.sources.
 * `fields` must be the recorded (validated) form: seeds come from the event log, so a live field the
 * log drops would otherwise read as a change on every pass.
 */
export function sampleKey(key: keyof SampleFields, fields: SampleFields): string {
  const evidence = fields.usageEvidence;
  if (key === "usageEvidence" && evidence) {
    const { measuredAt: _, sources, ...rest } = evidence;
    return canonical({ ...rest, sources: sources.map(canonical).sort() });
  }
  return canonical(fields[key]);
}

/** What the events already say per contact, so repeated passes and restarts emit nothing twice. */
function seedAll(events: Event[], derived: Derived): (ticket: string) => Seen {
  const seeds = new Map<string, Seen>();
  const of = (ticket: string): Seen => {
    let seen = seeds.get(ticket);
    if (!seen) {
      const d = derived.contacts[ticket];
      seen = {
        phase: d?.lastPhase ?? null,
        gate: null,
        up: d?.socketUp ?? false,
        generation: null,
        sample: {},
        missionId: d?.lastSample?.mission?.id ?? null,
        blocked: false,
      };
      for (const key of SAMPLE_GROUPS) if (d?.lastSample?.[key] !== undefined) seen.sample[key] = sampleKey(key, d.lastSample);
      seeds.set(ticket, seen);
    }
    return seen;
  };
  for (const e of events) {
    if (!("contact" in e)) continue;
    if (e.kind === "blocked") of(e.contact).blocked = true;
    else if (e.kind === "unblocked") of(e.contact).blocked = false;
    else if (e.kind === "gate-armed") of(e.contact).gate = e.gate;
    else if (e.kind === "socket-up") of(e.contact).generation = e.generation;
  }
  return of;
}

export interface Watcher {
  /** One serialized pass over every open operation, or just `only`; `force` samples now. */
  pass(only?: string | null, force?: boolean): Promise<void>;
  /** Capture only final status evidence on the same chain; no tracker, delivery, ping or terminal probes. */
  capture(operation: Operation, contact: Contact, status?: ContactStatus | null): Promise<void>;
  extras(opId: string): Required<ProjectionExtras>;
}

export function createWatcher(deps: WatcherDeps): Watcher {
  const ops = new Map<string, OpState>();
  const warned = new Set<string>();
  let running: Promise<void> | null = null;

  async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      const message = `${label}: ${messageOf(error)}`;
      if (!warned.has(message)) {
        warned.add(message);
        deps.warn(message);
      }
      return undefined;
    }
  }

  async function sample(op: Operation, ticket: string, seen: Seen, live: SampleFields): Promise<void> {
    const at = deps.now().toISOString();
    const fields = validateEvent({ v: 1, at, kind: "sample", contact: ticket, ...live }) as Extract<Event, { kind: "sample" }>;
    const changes: SampleFields = {};
    const keys: Partial<Record<keyof SampleFields, string>> = {};
    const newRun = !!fields.mission && fields.mission.id !== seen.missionId;
    for (const key of SAMPLE_GROUPS) {
      const value = fields[key];
      if (value === undefined) continue;
      const serialized = sampleKey(key, fields);
      const perRun = key === "measurements" || key === "usageEvidence" || key === "usage";
      if (serialized !== seen.sample[key] || (newRun && perRun)) {
        Object.assign(changes, { [key]: value });
        keys[key] = serialized;
      }
    }
    if (!Object.keys(changes).length) return;
    await appendEvent(deps.home, op.id, { v: 1, at, kind: "sample", contact: ticket, ...changes });
    if (newRun) {
      delete seen.sample.measurements;
      delete seen.sample.usageEvidence;
      delete seen.sample.usage;
    }
    Object.assign(seen.sample, keys);
    if (fields.mission) seen.missionId = fields.mission.id;
  }

  /** The card shows a mission's report after it lands and its status is gone, so each new one is saved. */
  async function keepReport(opId: string, ticket: string, report: MissionReport, state: OpState | undefined): Promise<void> {
    const key = JSON.stringify(report);
    if (state?.reports[ticket] === key) return;
    await saveContactReport(deps.home, opId, ticket, report);
    if (state) state.reports[ticket] = key;
  }

  function statusFields(status: ContactStatus | null, usage: boolean): SampleFields {
    if (!status) return {};
    const mission: NonNullable<SampleFields["mission"]> = { id: status.id, hold: status.hold, verify: status.verify ?? null, complete: status.complete };
    // A finished mission's leftover problem is not a stall; an older producer that reports none stays unknown.
    if (status.problem !== undefined)
      mission.problem = status.problem && !status.complete ? { kind: status.problem.kind, source: status.problem.source, retryAt: status.problem.retryAt } : null;
    return {
      mission,
      ...(status.measurements !== undefined ? { measurements: status.measurements } : {}),
      ...(usage && status.workers ? { workers: status.workers.live } : {}),
      ...(usage && status.usage ? { usage: { tokens: status.usage.tokens, costUsd: status.usage.costUsd } } : {}),
      ...(usage && status.usageEvidence !== undefined ? { usageEvidence: status.usageEvidence } : {}),
    };
  }

  async function passContact(
    op: Operation,
    contact: Contact,
    state: OpState,
    ports: Ports,
    seen: Seen,
    derived: ContactDerived | undefined,
    sampling: boolean,
    omp: number,
  ): Promise<void> {
    const ticket = contact.ticket;
    const lane = contact.lane;
    if (!lane) return;
    const at = () => deps.now().toISOString();
    if (derived?.landed || derived?.reaped) return;

    const read = await guard(`fleet read ${ticket}`, () => ports.fleet.read({ worktree: lane.worktree }));
    if (read !== undefined) state.statuses[ticket] = read;
    const status = state.statuses[ticket] ?? null;
    const report = status?.report;
    if (report) await guard(`report ${ticket}`, () => keepReport(op.id, ticket, report, state));

    let owner: Owner = "none";
    const live = status?.ctl ? await guard(`ping ${ticket}`, () => ports.fleet.ping(status)) : false;
    // A socket-free pane can still be a running process: liveness is independent of
    // whether its last write was fresh, so a hung-then-quiet producer still shows.
    const alive = live ? null : status?.session ? await guard(`process ${ticket}`, () => ports.fleet.running(status)) : null;
    if (live) owner = "live";
    else if (alive === true || hasRecentUncontrolledStatus(status, deps.now().getTime())) owner = "observed";
    else if (status && (seen.up || derived?.socketEver)) owner = "offline";
    state.owners[ticket] = owner;
    if (alive === false) state.gone.add(ticket); else state.gone.delete(ticket);

    if (status && status.phase !== seen.phase) {
      await appendEvent(deps.home, op.id, { v: 1, at: at(), kind: "phase", contact: ticket, from: seen.phase, to: status.phase });
      seen.phase = status.phase;
    }
    const gateId = status?.gate?.id ?? null;
    if (gateId && gateId !== seen.gate) {
      await appendEvent(deps.home, op.id, { v: 1, at: at(), kind: "gate-armed", contact: ticket, gate: gateId });
      seen.gate = gateId;
    }
    if (owner === "live" && status?.ctl) {
      const generation = status.ctl.generation;
      if (seen.up && seen.generation !== generation) {
        await appendEvent(deps.home, op.id, { v: 1, at: at(), kind: "socket-down", contact: ticket });
        seen.up = false;
      }
      if (!seen.up) {
        await appendEvent(deps.home, op.id, { v: 1, at: at(), kind: "socket-up", contact: ticket, generation });
        seen.up = true;
        seen.generation = generation;
      }
    } else if (seen.up && (owner === "offline" || (status && !status.ctl))) {
      await appendEvent(deps.home, op.id, { v: 1, at: at(), kind: "socket-down", contact: ticket });
      seen.up = false;
    }

    const fields = statusFields(status, sampling);
    if (!sampling) {
      await sample(op, ticket, seen, fields);
      return;
    }
    // A closer named CLOSER is no tracker issue: asking the tracker would only fail every pass.
    if (op.tracker !== "none" && (contact.kind !== "closer" || trackerTicket(op.tracker, ticket))) {
      const tracked = await guard(`tracker ${ticket}`, () => ports.tracker.sample(ticket, op.repo));
      if (tracked) fields.tracker = tracked;
    }
    if (status && (status.delivery?.branch || status.delivery?.url || lane.branch)) {
      const probe = await guard(`delivery ${ticket}`, () => ports.delivery.probe({ operation: op, contact, status }));
      // A probe that ran and found nothing reports null; a probe that could not run
      // (guard) or has no answer yet keeps the last known delivery in the sample.
      if (probe) state.probes[ticket] = probe;
      const live = state.probes[ticket];
      if (live) fields.delivery = {
        url: live.url, state: live.state, mergeable: live.mergeable, checks: live.checks,
        ...(live.queuedSince ? { queuedSince: live.queuedSince } : {}),
      };
    }
    fields.omp = omp;
    if (Object.keys(fields).some((key) => key !== "omp")) await sample(op, ticket, seen, fields);
  }

  async function passOperation(
    op: Operation,
    events: Event[],
    state: OpState,
    force: boolean,
    omp: number,
    settings: Settings,
    getTerminals: (ports: Ports) => Promise<ListedTerminal[] | null>,
    folded: Derived,
  ): Promise<void> {
    const now = deps.now().getTime();
    const sampling = force || now - state.lastSampleAt >= settings.sampleMs;
    const ports = deps.portsFor(op, settings);
    const seeds = seedAll(events, folded);
    for (const contact of op.contacts)
      await passContact(op, contact, state, ports, seeds(contact.ticket), folded.contacts[contact.ticket], sampling, omp);
    if (sampling) state.lastSampleAt = now;
    const needsTerminals = needsTerminalList(op, folded, state);
    const listed = needsTerminals ? await getTerminals(ports) : null;
    trackTerminals(op, folded, state, listed);
    await trackDecisionPanes(op, folded, state, ports, listed);
    await probeIntegration(op, state);
    for (const contact of op.contacts) {
      if (contact.lane || folded.contacts[contact.ticket]?.landed) continue;
      if (seeds(contact.ticket).blocked && unmetBlockers(op, folded, contact.ticket).length === 0)
        await appendEvent(deps.home, op.id, { v: 1, at: deps.now().toISOString(), kind: "unblocked", contact: contact.ticket });
    }
    state.open = openCount(op, folded, state);
    // Extras changes the board cannot see in events alone (status text, owners, probes,
    // integration dirt) still reach stream clients: the fingerprint moves with them.
    const fp = JSON.stringify([state.statuses, state.owners, state.probes, state.integrationDirty, state.open, [...state.vanished].sort(), [...state.gone].sort(), [...state.decisionPanes].sort()]);
    if (fp !== state.fp) {
      state.fp = fp;
      notifyChanged();
    }
  }

  /** Dirty-path count of the integration checkout: the header warns before a land ever runs. */
  async function probeIntegration(op: Operation, state: OpState): Promise<void> {
    if (!deps.run || !op.integration) {
      state.integrationDirty = null;
      return;
    }
    const r = await guard(`integration status ${op.id}`, () => deps.run!("git", ["status", "--porcelain"], op.integration));
    if (r === undefined) return;
    state.integrationDirty = r.code === 0 ? r.stdout.split("\n").filter((l) => l.trim().length > 0).length : null;
  }

  /** Terminal identity controls Focus; a successful mission ping remains authoritative for ownership. */
  function trackTerminals(op: Operation, folded: Derived, state: OpState, listed: ListedTerminal[] | null): void {
    // No list this pass (frontend cannot enumerate, the call failed, or nothing is
    // worth listing): drop only the vanished entries that are no longer possible.
    if (!listed) {
      clearStaleVanished(op, folded, state);
      return;
    }
    state.vanished = new Set();
    for (const contact of op.contacts) {
      const terminal = contact.lane?.terminal;
      if (!terminal || folded.contacts[contact.ticket]?.reaped || folded.contacts[contact.ticket]?.landed) continue;
      if (listed.some((row) => row.handle === terminal.handle && row.incarnationId === terminal.incarnationId)) continue;
      state.vanished.add(contact.ticket);
      if (state.owners[contact.ticket] !== "live" && state.owners[contact.ticket] !== "observed") state.owners[contact.ticket] = "offline";
    }
  }

  /**
   * Decision-agent panes: a written answer lands the contact (`decided` by the agent); an unreadable
   * one is recorded once and left for the operator; a pane that closed with no answer is a failure.
   */
  async function trackDecisionPanes(
    op: Operation,
    folded: Derived,
    state: OpState,
    ports: Ports,
    listed: ListedTerminal[] | null,
  ): Promise<void> {
    const at = () => deps.now().toISOString();
    for (const ticket of [...state.decisionPanes]) {
      const contact = op.contacts.find((c) => c.ticket === ticket && c.kind === "decision");
      const pane = await guard(`decision pane ${ticket}`, () => readDecisionPane(deps.home, op.id, ticket));
      if (!contact || pane === null) {
        // Gone or unreadable record, or the contact vanished: the file is not a pane we own.
        if (pane === null) await removeDecisionPane(deps.home, op.id, ticket).catch(() => undefined);
        state.decisionPanes.delete(ticket);
        continue;
      }
      if (pane === undefined) continue;
      if (folded.contacts[ticket]?.landed) {
        await guard(`decision close ${ticket}`, () => ports.frontend.close(pane.terminal, op.integration));
        await removeDecisionPane(deps.home, op.id, ticket).catch(() => undefined);
        state.decisionPanes.delete(ticket);
        continue;
      }
      const doc = await guard(`decision read ${ticket}`, () => readDecisionDoc(deps.home, op.id, ticket));
      if (doc === undefined) continue;
      if (doc !== null) {
        try {
          const decision = validateDecision(doc, contact);
          await appendEvent(deps.home, op.id, { v: 1, at: at(), kind: "decided", contact: ticket, by: "agent", ...decision });
          await appendEvent(deps.home, op.id, { v: 1, at: at(), kind: "landed", contact: ticket, via: "manual" });
          await guard(`decision close ${ticket}`, () => ports.frontend.close(pane.terminal, op.integration));
          await removeDecisionPane(deps.home, op.id, ticket).catch(() => undefined);
          state.decisionPanes.delete(ticket);
        } catch (error) {
          const message = messageOf(error);
          if (pane.error === undefined) {
            await appendEvent(deps.home, op.id, {
              v: 1, at: at(), kind: "operator", contact: ticket, op: "decide-agent", ok: false,
              error: `decision rejected: ${message}`,
            });
            await writeDecisionPane(deps.home, op.id, ticket, { ...pane, error: message }).catch(() => undefined);
          }
        }
        continue;
      }
      // No answer yet: a terminal the frontend stopped listing decided nothing.
      if (
        listed &&
        !listed.some((row) => row.handle === pane.terminal.handle && row.incarnationId === pane.terminal.incarnationId)
      ) {
        if (pane.error === undefined)
          await appendEvent(deps.home, op.id, {
            v: 1, at: at(), kind: "operator", contact: ticket, op: "decide-agent", ok: false,
            error: "pane closed before deciding",
          });
        await removeDecisionPane(deps.home, op.id, ticket).catch(() => undefined);
        state.decisionPanes.delete(ticket);
      }
    }
    // Replay supplies the committed baseline, including panes whose contacts were removed.
    const entries = await guard("decision sessions", async () => {
      try {
        return await readdir(decisionsDir(deps.home, op.id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    });
    for (const entry of entries ?? []) {
      if (!entry.endsWith(".sessions")) continue;
      let ticket: string;
      try {
        ticket = decodeURIComponent(entry.slice(0, -".sessions".length));
      } catch {
        continue;
      }
      if (encodeURIComponent(ticket) + ".sessions" !== entry) continue;
      const dir = join(decisionsDir(deps.home, op.id), entry);
      const summary = await guard(`pane usage ${ticket}`, () => summarizePaneSessions(dir, state.paneSigs));
      if (!summary) continue;
      const ev = folded.evaluation?.contacts[ticket];
      const tokens = {
        input: Math.max(0, summary.tokens.input - (ev?.paneEmittedTokens.input ?? 0)),
        output: Math.max(0, summary.tokens.output - (ev?.paneEmittedTokens.output ?? 0)),
        cacheRead: Math.max(0, summary.tokens.cacheRead - (ev?.paneEmittedTokens.cacheRead ?? 0)),
        cacheWrite: Math.max(0, summary.tokens.cacheWrite - (ev?.paneEmittedTokens.cacheWrite ?? 0)),
      };
      const sessions = Math.max(0, summary.sessions - (ev?.paneSessions ?? 0));
      const costUsd = summary.costUsd === null ? null : Math.max(0, summary.costUsd - (ev?.paneEmittedCostUsd ?? 0));
      const malformedLines = Math.max(0, summary.malformedLines - (ev?.paneMalformed ?? 0));
      const truncated = summary.truncated && ev?.paneTruncated !== true;
      const grew = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0 || sessions > 0 || malformedLines > 0 || (costUsd ?? 0) > 0 || truncated;
      if (!grew) {
        if (summary.signature) state.paneSigs.set(dir, summary.signature);
        continue;
      }
      const committed = await guard(`pane usage append ${ticket}`, async () => {
        await appendEvent(deps.home, op.id, {
          v: 1, at: at(), kind: "pane-usage", contact: ticket, pane: `pane:${ev?.paneEvents ?? 0}`,
          tokens, costUsd, sessions,
          ...(malformedLines > 0 ? { malformedLines } : {}),
          ...(truncated ? { truncated } : {}),
        });
        return true;
      });
      if (committed && summary.signature) state.paneSigs.set(dir, summary.signature);
    }
  }

  async function run(only: string | null, force: boolean): Promise<void> {
    const settings = await deps.settings();
    const rows = await listOperations(deps.home);
    for (const known of [...ops.keys()]) if (!rows.some((row) => row.id === known)) ops.delete(known);
    // Load first, across every operation, so a sample's omp count does not depend on pass order.
    const loaded: Array<{ op: Operation; events: Event[]; state: OpState; folded: Derived }> = [];
    for (const row of rows) {
      const read = await guard(`operation ${row.id}`, async () => {
        const op = await readOperation(deps.home, row.id);
        const { events, derived: folded } = await readFolded(deps.home, row.id);
        return { op, events, folded };
      });
      if (!read) continue;
      const state = ops.get(row.id) ?? newOpState();
      ops.set(row.id, state);
      const listsPanes = state.decisionPanes.size > 0 || read.op.contacts.some((c) => c.kind === "decision");
      state.decisionPanes = listsPanes
        ? new Set(await listDecisionPanes(deps.home, row.id).catch(() => [...state.decisionPanes]))
        : new Set<string>();
      clearStaleVanished(read.op, read.folded, state);
      for (const ticket of [...state.gone]) if (!contactOf(read.op, ticket)) state.gone.delete(ticket);
      state.open = openCount(read.op, read.folded, state);
      loaded.push({ ...read, state });
    }
    const omp = loaded.reduce((sum, item) => sum + item.state.open, 0);
    const terminalCache = new Map<string, Promise<ListedTerminal[] | null>>();
    const getTerminals = async (ports: Ports): Promise<ListedTerminal[] | null> => {
      const id = ports.frontend.id;
      if (GLOBAL_FRONTENDS[id]) {
        let pending = terminalCache.get(id);
        if (!pending) {
          pending = guard("terminals", () => ports.frontend.listTerminals()).then((res) => res ?? null);
          terminalCache.set(id, pending);
        }
        return await pending;
      }
      const res = await guard("terminals", () => ports.frontend.listTerminals());
      return res ?? null;
    };
    for (const item of loaded) {
      if (only && item.op.id !== only) continue;
      await guard(`operation ${item.op.id}`, () => passOperation(item.op, item.events, item.state, force, omp, settings, getTerminals, item.folded));
    }
  }

  /** Serialized: a slow pass or capture is never overlapped by the next one. */
  function enqueue(work: () => Promise<void>): Promise<void> {
    const next = (running ?? Promise.resolve()).catch(() => undefined).then(work);
    const tracked = next.finally(() => {
      if (running === tracked) running = null;
    });
    running = tracked;
    return tracked;
  }

  return {
    pass: (only = null, force = false) => enqueue(() => run(only, force)),
    capture(operation, contact, status) {
      return enqueue(async () => {
        if (!contact.lane) return;
        const { events, derived } = await readFolded(deps.home, operation.id);
        if (events.some((e) => e.kind === "closed")) return;
        const seen = seedAll(events, derived)(contact.ticket);
        const current = status === undefined
          ? await deps.portsFor(operation, await deps.settings()).fleet.read({ worktree: contact.lane.worktree })
          : status;
        await sample(operation, contact.ticket, seen, statusFields(current, true));
        if (current?.report) await keepReport(operation.id, contact.ticket, current.report, ops.get(operation.id));
      });
    },
    extras(opId: string): Required<ProjectionExtras> {
      const state = ops.get(opId);
      const open = [...ops.values()].reduce((sum, s) => sum + s.open, 0);
      const load: Load = { live: state?.open ?? 0, open };
      return { statuses: state?.statuses ?? {}, owners: state?.owners ?? {}, probes: state?.probes ?? {}, load, vanished: state?.vanished ?? new Set(), gone: state?.gone ?? new Set(), decisionPanes: state?.decisionPanes ?? new Set(), integrationDirty: state?.integrationDirty ?? null };
    },
  };
}
