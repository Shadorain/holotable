import { foldEvents } from "../core/fold.ts";
import { unmetBlockers } from "../core/graph.ts";
import type {
  Contact,
  ContactDerived,
  Derived,
  ContactStatus,
  DeliveryProbe,
  Event,
  Load,
  Operation,
  Owner,
  SampleFields,
  Settings,
} from "../core/types.ts";
import type { Ports } from "../ports.ts";
import type { ProjectionExtras } from "../snapshot.ts";
import type { ListedTerminal } from "../ports.ts";
import { appendEvent, readEvents } from "../store/events.ts";
import { listDecisionPanes, readDecisionDoc, readDecisionPane, removeDecisionPane, validateDecision, writeDecisionPane } from "../store/decisions.ts";
import { listOperations, readOperation } from "../store/operations.ts";

export interface WatcherDeps {
  home: string;
  now(): Date;
  settings(): Promise<Settings>;
  portsFor(operation: Operation, settings: Settings): Ports;
  /** Port failures and similar; the watcher never throws out of a pass. */
  warn(message: string): void;
}

/** What the watcher has already written for a contact, so a restart or a repeated pass emits nothing twice. */
interface Seen {
  phase: string | null;
  gate: string | null;
  up: boolean;
  generation: number | null;
  sample: string | null;
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
  /** Decision contacts with an open agent pane (decisions/<ticket>.pane.json on disk). */
  decisionPanes: Set<string>;
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
    const contact = op.contacts.find((c) => c.ticket === ticket);
    const d = folded.contacts[ticket];
    if (!contact?.lane?.terminal || d?.landed || d?.reaped) {
      state.vanished.delete(ticket);
    }
  }
}

/**
 * Panes whose omp can still be running. The cap protects memory, so a pane whose owner is dead holds no
 * slot: counting it would keep Relaunch and Recovery from replacing the very pane that is blocking them.
 */
function openCount(op: Operation, folded: Derived, state: OpState): number {
  let n = state.decisionPanes.size;
  for (const contact of op.contacts) {
    if (!contact.lane?.terminal || folded.contacts[contact.ticket]?.reaped) continue;
    if (state.vanished.has(contact.ticket) || state.owners[contact.ticket] === "offline") continue;
    n += 1;
  }
  return n;
}

function sampleKey(fields: SampleFields): string {
  return JSON.stringify([fields.tracker ?? null, fields.delivery ?? null, fields.workers ?? null, fields.omp ?? null, fields.usage ?? null]);
}

/** What the events already say per contact, so repeated passes and restarts emit nothing twice. */
function seedAll(events: Event[], derived: Derived): (ticket: string) => Seen {
  const seeds = new Map<string, Seen>();
  const of = (ticket: string): Seen => {
    let seen = seeds.get(ticket);
    if (!seen) {
      const d = derived.contacts[ticket];
      seen = { phase: d?.lastPhase ?? null, gate: null, up: d?.socketUp ?? false, generation: null, sample: null, blocked: false };
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
    else if (e.kind === "sample")
      of(e.contact).sample = sampleKey({
        ...(e.tracker ? { tracker: e.tracker } : {}),
        ...(e.delivery ? { delivery: e.delivery } : {}),
        ...(e.workers !== undefined ? { workers: e.workers } : {}),
        ...(e.omp !== undefined ? { omp: e.omp } : {}),
        ...(e.usage !== undefined ? { usage: e.usage } : {}),
      });
  }
  return of;
}

export interface Watcher {
  /** One serialized pass over every open operation, or just `only`; `force` samples now. */
  pass(only?: string | null, force?: boolean): Promise<void>;
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
      const message = `${label}: ${error instanceof Error ? error.message : String(error)}`;
      if (!warned.has(message)) {
        warned.add(message);
        deps.warn(message);
      }
      return undefined;
    }
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

    let owner: Owner = "none";
    if (status?.ctl) owner = (await guard(`ping ${ticket}`, () => ports.fleet.ping(status))) ? "live" : "offline";
    // A session that exits cleanly publishes ctl: null. For a lane whose socket the board has seen, that is
    // a dead owner like any other, not "no control socket", or Recovery would never see the closed pane.
    else if (status && (seen.up || derived?.socketEver)) owner = "offline";
    state.owners[ticket] = owner;

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

    if (!sampling) return;
    const fields: SampleFields = {};
    if (op.tracker !== "none") {
      const tracked = await guard(`tracker ${ticket}`, () => ports.tracker.sample(ticket, op.repo));
      if (tracked) fields.tracker = tracked;
    }
    if (status && (status.delivery?.branch || status.delivery?.url || lane.branch)) {
      const probe = await guard(`delivery ${ticket}`, () => ports.delivery.probe({ operation: op, contact, status }));
      if (probe !== undefined) state.probes[ticket] = probe;
      const live = state.probes[ticket];
      if (live) fields.delivery = { url: live.url, state: live.state, mergeable: live.mergeable, checks: live.checks };
    }
    if (status?.workers) fields.workers = status.workers.live;
    if (status?.usage) fields.usage = { tokens: status.usage.tokens, costUsd: status.usage.costUsd };
    fields.omp = omp;
    const key = sampleKey(fields);
    if (key !== seen.sample && (fields.tracker || fields.delivery || fields.workers !== undefined || fields.usage !== undefined)) {
      await appendEvent(deps.home, op.id, { v: 1, at: at(), kind: "sample", contact: ticket, ...fields });
      seen.sample = key;
    }
  }

  async function passOperation(
    op: Operation,
    events: Event[],
    state: OpState,
    force: boolean,
    omp: number,
    settings: Settings,
    getTerminals: (ports: Ports) => Promise<ListedTerminal[] | null>,
  ): Promise<void> {
    const now = deps.now().getTime();
    const folded = foldEvents(events);
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
    for (const contact of op.contacts) {
      if (contact.lane || folded.contacts[contact.ticket]?.landed) continue;
      if (seeds(contact.ticket).blocked && unmetBlockers(op, folded, contact.ticket).length === 0)
        await appendEvent(deps.home, op.id, { v: 1, at: deps.now().toISOString(), kind: "unblocked", contact: contact.ticket });
    }
    state.open = openCount(op, folded, state);
  }

  /** A terminal the frontend stopped listing is gone however alive its last status looked. */
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
      state.owners[contact.ticket] = "offline";
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
          const message = error instanceof Error ? error.message : String(error);
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
  }

  async function run(only: string | null, force: boolean): Promise<void> {
    const settings = await deps.settings();
    const rows = await listOperations(deps.home);
    for (const known of [...ops.keys()]) if (!rows.some((row) => row.id === known)) ops.delete(known);
    // Load first, across every operation, so a sample's omp count does not depend on pass order.
    const loaded: Array<{ op: Operation; events: Event[]; state: OpState }> = [];
    for (const row of rows) {
      const read = await guard(`operation ${row.id}`, async () => {
        const op = await readOperation(deps.home, row.id);
        const events = await readEvents(deps.home, row.id);
        return { op, events };
      });
      if (!read) continue;
      const state = ops.get(row.id) ?? { statuses: {}, owners: {}, probes: {}, lastSampleAt: 0, open: 0, vanished: new Set<string>(), decisionPanes: new Set<string>() };
      ops.set(row.id, state);
      const listsPanes = state.decisionPanes.size > 0 || read.op.contacts.some((c) => c.kind === "decision");
      state.decisionPanes = listsPanes
        ? new Set(await listDecisionPanes(deps.home, row.id).catch(() => [...state.decisionPanes]))
        : new Set<string>();
      const folded = foldEvents(read.events);
      clearStaleVanished(read.op, folded, state);
      state.open = openCount(read.op, folded, state);
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
      await guard(`operation ${item.op.id}`, () => passOperation(item.op, item.events, item.state, force, omp, settings, getTerminals));
    }
  }

  /** Serialized: a slow pass is never overlapped by the next tick. */
  function pass(only: string | null = null, force = false): Promise<void> {
    const next = (running ?? Promise.resolve()).then(() => run(only, force));
    const tracked = next.finally(() => {
      if (running === tracked) running = null;
    });
    running = tracked;
    return tracked;
  }

  return {
    pass,
    extras(opId: string): Required<ProjectionExtras> {
      const state = ops.get(opId);
      const open = [...ops.values()].reduce((sum, s) => sum + s.open, 0);
      const load: Load = { live: state?.open ?? 0, open };
      return { statuses: state?.statuses ?? {}, owners: state?.owners ?? {}, probes: state?.probes ?? {}, load, vanished: state?.vanished ?? new Set(), decisionPanes: state?.decisionPanes ?? new Set() };
    },
  };
}
