import { contactDerived } from "./fold.ts";
import { unmetBlockers } from "./graph.ts";
import { missionProblem, retryWaiting } from "./mission-problem.ts";
import type {
  ActionView,
  Contact,
  ContactState,
  Derived,
  Operation,
  PolicyInput,
} from "./types.ts";

/**
 * C7 state table, first match wins. `conflictContacts` are the contacts whose
 * `conflictOf` names this ticket, with their already-computed states.
 */
export function contactState(i: {
  operation: Operation;
  contact: Contact;
  derived: Derived;
  status: PolicyInput["status"];
  owner: PolicyInput["owner"];
  conflictContacts: Array<{ contact: Contact; state: ContactState }>;
}): ContactState {
  const { contact, derived, status, owner, conflictContacts } = i;
  const d = contactDerived(derived, contact.ticket);
  if (d.landed) return "landed";
  if (contact.lane === null) {
    if (contact.kind === "decision") return "decision";
    if (unmetBlockers(i.operation, derived, contact.ticket).length > 0)
      return "blocked";
    return "ready";
  }
  if (
    conflictContacts.some(
      (c) => c.state !== "complete" && c.state !== "landed",
    )
  )
    return "conflict";
  if (status === null) {
    if (!d.socketEver && contact.lane.terminal !== null && d.launchFailed === null) return "planning";
    return "offline";
  }
  if ((owner === "offline" || d.reaped) && !status.complete) return "offline";
  if (status.hold !== "none") return "hold";
  if (status.complete) return "complete";
  if (retryWaiting(status)) return "waiting";
  if (missionProblem(status)) return "hold";
  if (status.actions.includes("resend")) return "hold";
  if (status.phase === "verify") return "verify";
  if (status.phase === "review") return "review";
  return "running";
}

/** First matching refusal reason, exact C7 strings, else null. */
export function launchRefusal(i: PolicyInput): string | null {
  const { operation, contact, derived, load, cap } = i;
  if (derived.closed) return "operation closed";
  if (contact.kind === "decision") return "decision tickets do not launch";
  if (contact.lane?.terminal != null) return "already launched";
  const blockers = unmetBlockers(operation, derived, contact.ticket);
  if (blockers.length > 0) return `blocked by ${blockers.join(", ")}`;
  if (load.open >= cap) return `cap ${load.open}/${cap} omp`;
  if (operation.frontend === "none")
    return "no frontend: set one with /holotable set frontend orca";
  if (operation.fleet === "none") return "no fleet configured";
  return null;
}

const FLEET_OPS = ["approve", "continue", "review", "dispatch", "resend", "release", "plan-approve", "retry-model"] as const;
const FLEET_OP_LABELS: Record<string, string> = {
  "retry-model": "Switch model & retry",
  "plan-approve": "Approve plan",
  approve: "Approve",
  continue: "Continue",
  review: "Review",
  dispatch: "Dispatch",
  resend: "Resend",
  release: "Release",
};

const view = (
  id: string,
  label: string,
  primary: boolean,
  enabled: boolean,
  reason: string | null = null,
): ActionView => ({ id, label, primary, enabled, reason });

export function actionsFor(i: PolicyInput): ActionView[] {
  const { operation, contact, derived, state, status, owner, probe } = i;
  const d = contactDerived(derived, contact.ticket);
  const terminal = contact.lane?.terminal ?? null;
  const refusal = launchRefusal(i);
  const capRefusal = derived.closed
    ? "operation closed"
    : i.load.open >= i.cap
      ? `cap ${i.load.open}/${i.cap} omp`
      : i.recoveryWait?.kind === "memory" ? i.recoveryWait.detail : null;
  /** Getting a dead pane back: close it (when listed) and open a fresh session in the same lane. */
  const relaunch = (): ActionView =>
    view("relaunch", "Relaunch", true, capRefusal === null, capRefusal);

  const focus = (): ActionView => {
    const ok = terminal !== null && contact.lane?.frontend !== "external" && !i.terminalMissing;
    return view(
      "focus",
      "Focus",
      false,
      ok,
      ok ? null : i.terminalMissing ? "terminal closed" : terminal === null ? "no terminal recorded" : "no frontend",
    );
  };
  const reap = (): ActionView => {
    const ok = terminal !== null && !d.reaped;
    return view(
      "reap",
      "Reap",
      false,
      ok,
      ok ? null : d.reaped ? "already reaped" : "no terminal recorded",
    );
  };
  /** Fleet ops rendered from status.actions; never computed locally. */
  const fleetButtons = (): ActionView[] => {
    if (status === null) return [];
    const ctlMissing =
      status.ctl === null ? "no control socket" : null;
    const buttons: ActionView[] = [];
    // Recovery handles plain resume holds; quota retries always require an operator.
    const recoverable = operation.recover === true && status.ctl !== null && status.verify !== "failed";
    const continueNeeded = status.hold === "quota" || (status.hold === "resume" && !recoverable) || status.verify === "failed";
    const primary = status.actions.includes("approve") ? "approve"
      : status.actions.includes("continue") && continueNeeded ? "continue"
      : status.actions.includes("resend") ? "resend"
      : status.actions.includes("release") ? "release"
      : status.phase === "review" && status.actions.includes("review") ? "review" : null;
    for (const op of status.actions) {
      if (!(FLEET_OPS as readonly string[]).includes(op)) continue;
      if (op === "continue" && !continueNeeded) continue;
      const enabled = ctlMissing === null && owner === "live";
      buttons.push(
        view(
          op,
          FLEET_OP_LABELS[op] ?? op,
          op === primary,
          enabled,
          enabled ? null : (ctlMissing ?? "owner-offline"),
        ),
      );
    }
    if (status.actions.includes("mode")) {
      const enabled = ctlMissing === null && owner === "live";
      buttons.push(
        view(
          "mode",
          "Mode",
          false,
          enabled,
          enabled ? null : (ctlMissing ?? "owner-offline"),
        ),
      );
    }
    return buttons;
  };

  /** Plan review: shown only while a pending plan awaits approval; the text itself is GET /api/plan. */
  const planButtons = (): ActionView[] => {
    if (status?.hold !== "plan-approval" || !status.plan) return [];
    const ctlMissing = status.ctl === null ? "no control socket (not launched by holotable)" : null;
    const enabled = ctlMissing === null && owner === "live";
    return [
      view("plan-save", "Save plan", false, enabled, enabled ? null : (ctlMissing ?? "owner-offline")),
      view("plan-refine", "Refine plan", false, enabled, enabled ? null : (ctlMissing ?? "owner-offline")),
    ];
  };

  switch (state) {
    case "ready":
      return [
        view("launch", "Launch", true, refusal === null, refusal),
      ];
    case "blocked":
      return [
        view("launch", "Launch", true, false, refusal ?? "blocked"),
        ...(contact.kind === "decision" ? [view("decide-agent", "Ask an agent", false, false, "blocked")] : []),
      ];
    case "decision": {
      let agentReason: string | null = null;
      if (unmetBlockers(i.operation, derived, contact.ticket).length > 0) agentReason = "blocked";
      else if (operation.frontend === "none") agentReason = "no frontend: set one with /holotable set frontend orca";
      else if (i.load.open >= i.cap) agentReason = `cap ${i.load.open}/${i.cap} omp`;
      else if (i.decisionPaneOpen) agentReason = "already asking an agent";
      return [
        view("done", "Mark decided", true, true),
        view("decide-agent", "Ask an agent", false, agentReason === null, agentReason),
      ];
    }
    case "waiting":
      if (owner === "live" && state === "waiting") return [focus(), ...fleetButtons(), reap()];
    case "offline": {
      const relaunchable =
        terminal !== null && operation.frontend !== "none" && contact.lane?.frontend !== "external";
      // A lane without a terminal is a launch that stopped early: Launch resumes it.
      if (contact.lane !== null && terminal === null && contact.lane.frontend !== "external")
        return [view("launch", "Launch", true, refusal === null, refusal), focus(), reap()];
      return [
        focus(),
        ...(relaunchable ? [relaunch()] : []),
        ...fleetButtons(),
        ...planButtons(),
        reap(),
      ];
    }
    case "planning":
    case "running":
    case "verify":
    case "review":
    case "hold":
      return [focus(), ...fleetButtons(), ...planButtons(), reap()];
    case "complete": {
      const actions: ActionView[] = [];
      if (contact.kind === "implement") {
        let reason: string | null = null;
        if (operation.delivery === "none") reason = "no delivery configured";
        else if (i.conflictOpen !== null)
          reason = `conflict mission ${i.conflictOpen} open`;
        else if (probe?.state === "closed") reason = "pull request closed";
        const failingChecks = reason === null && probe?.checks === "fail" && !operation.ignoreChecks;
        if (failingChecks)
          reason = probe.failing?.length ? `failing check: ${probe.failing.join(", ")}` : "a required check failed";
        actions.push(view("land", "Land", true, reason === null, reason));
        // The operator can still land past red CI for this one PR; auto mode only looks at `land`.
        if (failingChecks) actions.push(view("land-anyway", "Land anyway", false, true));
        if (operation.delivery === "none")
          actions.push(view("done", "Mark done", false, true));
      } else {
        // audit and conflict contacts never land: done is the exit.
        // A finished conflict mission is not the operator's next step: Land on the original is.
        actions.push(view("done", "Mark done", contact.kind !== "conflict", true));
      }
      actions.push(focus(), reap());
      return actions;
    }
    case "conflict":
      return [
        view(
          "land",
          "Land",
          true,
          false,
          `conflict mission ${i.conflictOpen ?? ""} open`,
        ),
        focus(),
        reap(),
      ];
    case "landed":
      if (contact.kind === "decision")
        return [view("redecide", "Change decision", false, true), reap()];
      return [reap()];
  }
}

const PANE_MEMORY_BYTES = 600 * 1024 * 1024;
const MEMORY_RESERVE_BYTES = 512 * 1024 * 1024;

export function memoryLaunchRefusal(available: number | null, pending = 0): string | null {
  if (available === null) return null;
  const required = MEMORY_RESERVE_BYTES + PANE_MEMORY_BYTES * (pending + 1);
  return available < required
    ? `memory pressure: ${Math.floor(available / 1024 / 1024)} MiB available; ${required / 1024 / 1024} MiB needed for another pane and reserve`
    : null;
}
