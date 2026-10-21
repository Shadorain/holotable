import { foldEvents, contactDerived } from "./fold.ts";
import { countTasks } from "./notes.ts";
import { actionsFor, contactState, handsOff, launchRefusal } from "./policy.ts";
import { computeStats } from "./stats.ts";
import { missionProblem, retryWaiting } from "./mission-problem.ts";
import type {
  Contact,
  ContactState,
  ContactView,
  Derived,
  Actor,
  Event,
  HistoryEntry,
  Operation,
  PolicyInput,
  Projection,
  ProjectionInput,
  Source,
} from "./types.ts";

const MAX_LOG = 50;
const ATTENTION_STATES: ContactState[] = ["hold", "offline", "decision", "review"];

/** Ticket of the newest unresolved conflict contact targeting `ticket`; a reaped (abandoned) one is not open. */
export function conflictOpenFor(
  op: Operation,
  states: ReadonlyMap<string, ContactState>,
  ticket: string,
  derived: Derived,
): string | null {
  let open: string | null = null;
  for (const c of op.contacts) {
    if (c.conflictOf !== ticket || contactDerived(derived, c.ticket).reaped) continue;
    const s = states.get(c.ticket);
    if (s !== "complete" && s !== "landed") open = c.ticket;
  }
  return open;
}

/**
 * Compute every contact's state. Conflict targets depend on the states of the
 * contacts targeting them, so iterate to a fixpoint (converges in ≤ contacts+2
 * passes; the cap keeps malformed graphs from looping).
 */
function computeStates(
  input: ProjectionInput,
  derived: Derived,
): Map<string, ContactState> {
  const { operation: op, statuses, owners } = input;
  const states = new Map<string, ContactState>();
  for (let pass = 0; pass < op.contacts.length + 2; pass += 1) {
    let changed = false;
    for (const c of op.contacts) {
      const conflictContacts = op.contacts
        .filter((x) => x.conflictOf === c.ticket)
        .map((x) => ({
          contact: x,
          state: states.get(x.ticket) ?? "ready",
        }));
      const s = contactState({
        operation: op,
        contact: c,
        derived,
        status: statuses[c.ticket] ?? null,
        owner: owners[c.ticket] ?? "none",
        conflictContacts,
      });
      const wait = input.recoveryWaits?.[c.ticket];
      const deferred = s === "offline" && op.recover && !contactDerived(derived, c.ticket).reaped &&
        input.statuses[c.ticket]?.hold !== "quota" && input.statuses[c.ticket]?.hold !== "question" && wait !== undefined;
      const state = deferred ? "waiting" : s;
      if (states.get(c.ticket) !== state) changed = true;
      states.set(c.ticket, state);
    }
    if (!changed) break;
  }
  return states;
}

const OPERATOR_VERBS: Record<string, string> = {
  "plan-approve": "plan approved",
  approve: "approved",
  continue: "continued",
  review: "review requested",
  dispatch: "dispatched",
  resend: "worker retry requested",
  release: "blocker release requested",
  mode: "mode changed",
  "plan-save": "plan saved",
  "plan-refine": "plan refine requested",
  answer: "question answered",
  relaunch: "relaunched",
  "land-anyway": "landed past failing checks",
};

const SOURCE_ACTOR: Record<Source, Actor> = { operator: "operator", model: "model", seed: "operator", conflict: "board" };
const SOURCE_ORIGIN: Record<Source, string> = {
  operator: "added by you",
  model: "queued by the model",
  seed: "seeded from the campaign file",
  conflict: "opened by a Land conflict",
};

/** Who caused an event. Mission-side changes come from the watcher reading the mission's own status. */
function actorOf(e: Event): Actor {
  switch (e.kind) {
    case "queued":
    case "adopted":
      return SOURCE_ACTOR[e.source ?? "operator"];
    case "edited":
      return SOURCE_ACTOR[e.source];
    case "phase":
    case "gate-armed":
    case "socket-up":
    case "socket-down":
    case "sample":
      return "mission";
    case "blocked":
    case "unblocked":
    case "removed":
      return "board";
    case "auto":
      return e.by === "board" ? "board" : "operator";
    case "recover":
      return e.by === "board" ? "board" : "operator";
    case "operator":
      return e.by !== undefined ? "board" : "operator";
    default:
      return "operator";
  }
}

/** Human history text. Ids that mean nothing to the operator (gate hashes, sockets) stay out. */
function historyLine(e: Event): HistoryEntry | null {
  const contact = "contact" in e ? e.contact : null;
  const line = (text: string, cls: HistoryEntry["cls"] = ""): HistoryEntry => ({ at: e.at, kind: e.kind, contact, actor: actorOf(e), cls, text });
  const ticket = contact ?? "";
  switch (e.kind) {
    case "queued":
      return line(`${ticket} ${SOURCE_ORIGIN[e.source ?? "operator"]}`);
    case "edited":
      return line(`${ticket} ${e.fields.join(", ")} changed ${e.source === "model" ? "by the model" : "by you"}`);
    case "blocked":
      return line(`${ticket} waiting on ${e.by.join(", ")}`);
    case "unblocked":
      return line(`${ticket} unblocked: ready to launch`, "ok");
    case "adopted":
      return line(`${ticket} adopted an existing checkout`);
    case "launched":
      return line(`${ticket} launched`, "ok");
    case "launch-failed":
      return line(`${ticket} launch failed (${e.step}): ${e.error}`, "err");
    case "socket-up":
      return line(`${ticket} mission session connected`, "ok");
    case "socket-down":
      return line(`${ticket} mission session disconnected`, "err");
    case "phase":
      return line(e.from ? `${ticket} ${e.from} → ${e.to}` : `${ticket} entered ${e.to}`);
    case "gate-armed":
      return line(`${ticket} waiting at a gate`);
    case "operator":
      // Launch, land, done and reap leave their own event; only their failures need a line.
      if (e.ok && !OPERATOR_VERBS[e.op]) return null;
      return e.ok
        ? line(`${ticket} ${OPERATOR_VERBS[e.op]}`, "ok")
        : line(`${ticket} ${e.op} failed${e.error ? `: ${e.error}` : ""}`, "err");
    case "land-attempt":
      return e.outcome === "clean"
        ? null
        : line(`${ticket} land hit conflicts${e.paths?.length ? ` in ${e.paths.join(", ")}` : ""}`, "err");
    case "conflict-opened":
      return line(`${ticket} conflict mission ${e.conflictContact} opened`, "err");
    case "landed":
      return line(`${ticket} landed${e.via === "manual" ? " (marked done)" : ` via ${e.via === "pr" ? "PR" : "merge"}`}`, "ok");
    case "reaped":
      return line(`${ticket} terminal closed`);
    case "removed":
      return line(`${ticket} worktree removed`, "ok");
    case "auto":
      return line(
        e.enabled ? "auto mode on" : e.reason === "every contact landed" ? "auto mode finished: every contact landed" : `auto mode paused: ${e.reason ?? "off"}`,
        e.enabled || e.reason === "every contact landed" ? "ok" : "err",
      );
    case "recover":
      return line(`recovery ${e.enabled ? "on" : "off"}`);
    case "workflow":
      return null;
    case "closed":
      return line(`operation closed: ${e.outcome}`);
    case "sample":
      return null;
    case "pane-usage":
      // Bookkeeping: spend is visible on Intel, not a human-meaningful history line.
      return null;
    case "decided":
      return line(`${ticket} decided: ${e.choice}${e.by !== "operator" ? ` (by ${e.by})` : ""}`);
  }
}

// Events an action leaves behind; the action's own `operator` event is written after them.
const ACTION_RESULTS = new Set<Event["kind"]>(["launched", "launch-failed", "landed", "land-attempt", "conflict-opened", "reaped"]);
const parentTicket = (ticket: string) => ticket.replace(/-conflict-\d+$/i, "");

/** Every human-readable entry, oldest first. */
export function history(events: Event[]): HistoryEntry[] {
  // Walk backwards so each action result can see the operator event that closes its action.
  const nextOp = new Map<string, { op: string; board: boolean }>();
  const out: HistoryEntry[] = [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i] as Event;
    const line = historyLine(e);
    if (line && e.kind !== "operator" && ACTION_RESULTS.has(e.kind) && "contact" in e) {
      const closing = nextOp.get(e.contact) ?? nextOp.get(parentTicket(e.contact));
      if (closing?.board) line.actor = "board";
      // A terminal closed by anything but an explicit Reap was the post-land cleanup.
      else if (e.kind === "reaped" && closing?.op !== "reap") line.actor = "board";
    }
    if (e.kind === "operator") nextOp.set(e.contact, { op: e.op, board: e.by !== undefined });
    if (line) out.push(line);
  }
  return out.reverse();
}

/** How a contact got onto the board, from its first queued/adopted event. */
function originOf(events: Event[], ticket: string): ContactView["origin"] {
  for (const e of events) {
    if (!("contact" in e) || e.contact !== ticket) continue;
    if (e.kind === "queued") return { actor: actorOf(e), at: e.at, text: SOURCE_ORIGIN[e.source ?? "operator"] };
    if (e.kind === "adopted") return { actor: actorOf(e), at: e.at, text: "adopted an existing checkout" };
  }
  return null;
}

/** One sentence for the card and list when the mission has nothing more specific to say. */
function detailFor(state: ContactState, view: { refusal: string | null; next: string | null; conflictOpen: string | null; blockers: string[]; conflictOf: string | null; deciding: boolean; autoDecides: boolean }): string {
  switch (state) {
    case "ready":
      return view.refusal ?? "Ready to launch";
    case "blocked":
      return view.blockers.length ? `Waiting on ${view.blockers.join(", ")} to land` : (view.refusal ?? "Blocked");
    case "decision":
      if (view.deciding) return "An agent is deciding in its pane";
      // Auto mode takes recommended answers at once; this only shows while it waits for a free slot.
      return view.autoDecides ? "Auto mode will ask an agent when a live slot frees up (or decide it yourself)" : "Decide, then mark decided";
    case "conflict":
      return `Waiting on conflict mission ${view.conflictOpen ?? ""}`.trim();
    case "landed":
      return "Landed";
    case "planning":
      return view.next ?? "Mission starting";
    case "offline":
      return view.next ? `Owner offline · last: ${view.next}` : "Owner offline · showing the last snapshot";
    case "waiting":
      return "Waiting to reconnect";
    case "complete":
      return view.conflictOf ? `Conflicts resolved: land ${view.conflictOf}` : (view.next ?? "Delivered");
    default:
      return view.next ?? state;
  }
}

function contactView(
  input: ProjectionInput,
  derived: Derived,
  contact: Contact,
  state: ContactState,
  conflictOpen: string | null,
  decisionPaneOpen: boolean,
): ContactView {
  const { operation: op, statuses, owners, probes } = input;
  const d = contactDerived(derived, contact.ticket);
  const status = statuses[contact.ticket] ?? null;
  const owner = owners[contact.ticket] ?? "none";
  const probe = probes[contact.ticket] ?? null;
  // A live review past its producer deadline means the pane stopped enforcing it:
  // either the producer died mid-round or it is stuck. The operator needs to see that.
  const review = state === "landed" ? null : status?.review ?? null;
  const reviewStale = review !== null && Date.parse(review.deadlineAt) <= input.now;
  const problem = state === "landed" ? null : missionProblem(status);
  const policy: PolicyInput = {
    operation: op,
    contact,
    derived,
    state,
    status,
    owner,
    probe,
    load: input.load,
    cap: input.cap,
    conflictOpen,
    decisionPaneOpen,
    recoveryWait: input.recoveryWaits?.[contact.ticket],
    terminalMissing: input.vanished?.has(contact.ticket) ?? false,
  };

  const blockers = contact.blockedBy.filter((b) => !contactDerived(derived, b).landed);
  let detail = state === "waiting" && !retryWaiting(status) ? input.recoveryWaits?.[contact.ticket]?.detail ?? "Waiting to reconnect" : detailFor(state === "waiting" ? "review" : state, {
    refusal: state === "ready" || state === "blocked" ? launchRefusal(policy) : null,
    next: status?.next ?? null,
    conflictOpen,
    blockers,
    conflictOf: contact.conflictOf,
    deciding: decisionPaneOpen,
    autoDecides: Boolean(op.auto?.enabled && op.auto.decide && op.frontend !== "none"),
  });
  if (state === "waiting" && problem?.retryAt)
    detail = `Review retry at ${problem.retryAt.slice(0, 16).replace("T", " ")} UTC`;
  if (reviewStale)
    detail = `Review stalled past its deadline (${review!.deadlineAt.slice(0, 16).replace("T", " ")} UTC); the pane may be stuck — Relaunch it`;
  const actions = actionsFor(policy);
  const hands = handsOff({ ...policy, actions, reviewStalled: reviewStale });
  if (state === "complete") {
    const next = actions.find(action => action.primary);
    detail = next?.reason ? `Mission complete; ${next.reason}`
      : next?.id === "land" && probe?.mergeable === "conflict" ? `Mission complete; its PR conflicts with ${op.base}, so Land opens a conflict mission`
      : next?.id === "land" ? "Mission complete; awaiting landing"
      : next?.label === "Mark merged" ? "Merged; record landing"
      : contact.conflictOf ? `Conflicts resolved: land ${contact.conflictOf}` : "Mission complete; ready to mark done";
  }

  const group: ContactView["group"] =
    contact.lane === null && !d.landed ? "queue" : "live";

  return {
    ticket: contact.ticket,
    title: contact.title,
    description: contact.description ?? null,
    zone: contact.zone,
    kind: contact.kind,
    group,
    state,
    hold: status?.hold ?? null,
    detail,
    problem,
    check: status?.check ?? null,
    ask: status?.hold === "question" ? status.ask ?? null : null,
    progress: status?.progress ?? null,
    phase: status?.phase ?? null,
    blockedBy: contact.blockedBy.map((t) => ({
      ticket: t,
      landed: contactDerived(derived, t).landed,
    })),
    tracker: d.lastSample?.tracker ?? null,
    delivery: probe ?? d.lastSample?.delivery ?? null,
    workers: status?.workers ?? null,
    owner,
    mode: status?.mode ?? null,
    usage: d.lastSample?.usage ? { tokens: d.lastSample.usage.tokens, costUsd: d.lastSample.usage.costUsd, sessions: status?.usage?.sessions ?? 0 } : (status?.usage ?? null),
    origin: originOf(input.events, contact.ticket),
    conflictOf: contact.conflictOf,
    lane: contact.lane
      ? { worktree: contact.lane.worktree, branch: contact.lane.branch, frontend: contact.lane.frontend, terminal: contact.lane.terminal !== null }
      : null,
    plan: status?.hold === "plan-approval" && status.plan ? { revision: status.plan.revision } : null,
    options: contact.options,
    review,
    model: status?.model ?? null,
    recommended: contact.recommended,
    decision: d.decision,
    decisionPane: decisionPaneOpen,
    // A decision an agent is working on is not waiting on the operator, nor is anything automation owns.
    attention: hands === null && ((ATTENTION_STATES.includes(state) && !(state === "decision" && decisionPaneOpen) &&
      (state !== "review" || status?.actions.includes("review") === true || reviewStale)) ||
      (state === "complete" && contact.kind !== "conflict")),
    handsOff: hands,
    actions,
  };
}

export function project(input: ProjectionInput): Projection {
  const op = input.operation;
  const derived = foldEvents(input.events);
  const states = computeStates(input, derived);

  const contacts = op.contacts.map((c) =>
    contactView(
      input,
      derived,
      c,
      states.get(c.ticket) ?? "ready",
      conflictOpenFor(op, states, c.ticket, derived),
      input.decisionPanes?.has(c.ticket) ?? false,
    ),
  );
  // Only a running pane's problem is current evidence: a reaped or dead pane's last quota error must not
  // hold every new launch in the operation forever.
  const capacityTickets = contacts.filter(c => c.state !== "landed" && c.state !== "offline" && (c.owner === "live" || c.owner === "observed") &&
    (c.problem?.kind === "quota" || c.problem?.kind === "rate-limit")).map(c => c.ticket);
  const capacityWait = capacityTickets.length ? `New AI work waits for provider capacity: ${capacityTickets.join(", ")}` : null;

  const selection =
    contacts.find((c) => c.group === "live")?.ticket ??
    contacts.find((c) => c.group === "queue")?.ticket ??
    null;

  const log = history(input.events).slice(-MAX_LOG).reverse();

  return {
    operation: {
      id: op.id,
      name: op.name,
      base: op.base,
      frontend: op.frontend,
      tracker: op.tracker,
      fleet: op.fleet,
      delivery: op.delivery,
      pause: op.pause,
      auto: op.auto ? { ...op.auto, capacityWait } : null,
      recover: op.recover,
      project: input.project,
      zones: op.zones.map((z, i) => ({
        ...z,
        angle: -20 + i * (360 / op.zones.length),
      })),
      integrationDirty: input.integrationDirty ?? null,
    },
    header: {
      live: input.load.live,
      open: input.load.open,
      cap: input.cap,
    },
    contacts,
    notes: countTasks(input.notesText),
    selection,
    stats: computeStats(derived, input.now, input.load.live),
    log,
  };
}

/** The contact named `ticket` in an operation or a projection, if any. */
export function contactOf<C extends { ticket: string }>(holder: { contacts: readonly C[] }, ticket: string): C | undefined {
  return holder.contacts.find((c) => c.ticket === ticket);
}

/** The action `id` a contact view offers, enabled or not. */
export function actionOf(view: ContactView | undefined, id: string): ContactView["actions"][number] | undefined {
  return view?.actions.find((a) => a.id === id);
}

/** Whether a contact view offers action `id` enabled. */
export function canDo(view: ContactView, id: string): boolean {
  return view.actions.some((a) => a.id === id && a.enabled);
}
