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

/** Frontends whose port implements `type()`, so the board can answer a mission's question in its pane. */
const TYPING_FRONTENDS: readonly string[] = ["orca"];

/** Observation is not control authority; an active review can stay quiet until its deadline. */
export function hasRecentUncontrolledStatus(status: PolicyInput["status"], now: number): boolean {
  if (!status || status.ctl !== null) return false;
  const age = now - Date.parse(status.updatedAt);
  if (age < 0) return false;
  if (status.phase === "review" && status.review && status.review.active > 0 &&
      now < Date.parse(status.review.deadlineAt)) return true;
  return age <= 90_000;
}

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

const FLEET_OPS = ["approve", "continue", "review", "dispatch", "resend", "release", "plan-approve", "retry-model", "check"] as const;
const FLEET_OP_LABELS: Record<string, string> = {
  check: "Check PR",
  "retry-model": "Switch model",
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
      status?.hold === "question" ? "Answer in mission" : "Focus",
      status?.hold === "question" && !status.ask,
      ok,
      ok ? null : i.terminalMissing ? "terminal closed" : terminal === null ? "no terminal recorded" : "no frontend",
    );
  };
  /** Answering the mission's open `ask` from the board: typed into its pane, so only frontends that can type. */
  const answer = (): ActionView[] => {
    if (status?.hold !== "question" || !status.ask) return [];
    const reason = terminal === null || i.terminalMissing ? "terminal closed"
      : !TYPING_FRONTENDS.includes(contact.lane?.frontend ?? "") ? "this frontend cannot type into the pane"
      : status.ask.questions.some((q) => q.multi) ? "multi-select questions are answered in the pane"
      : null;
    return [view("answer", "Answer", true, reason === null, reason)];
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
    if (status === null || status.hold === "question") return [];
    const ctlMissing =
      status.ctl === null ? "no control socket" : null;
    const buttons: ActionView[] = [];
    // Recovery handles plain resume holds; quota retries always require an operator.
    const recoverable = operation.recover === true && status.ctl !== null && status.verify !== "failed";
    const continueNeeded = status.hold === "quota" || (status.hold === "resume" && !recoverable) || status.verify === "failed";
    // Continue on an exhausted subscription only fails again; switching the model is the way forward.
    const quota = status.hold === "quota" || missionProblem(status)?.kind === "quota";
    const primary = status.actions.includes("approve") ? "approve"
      : quota && status.actions.includes("retry-model") ? "retry-model"
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
      return [...answer(), focus(), ...fleetButtons(), ...planButtons(), reap()];
    case "complete": {
      const actions: ActionView[] = [];
      // An audit that opened a PR (or committed on a local-merge base) carries code like any implementation.
      const carriesCode = contact.kind === "implement" || (contact.kind === "audit" && probe !== null);
      if (carriesCode && probe?.state === "merged") {
        // Merged outside the board (or by an earlier Land): recording it is the only step left.
        actions.push(view("done", "Mark merged", true, true));
      } else if (carriesCode) {
        let reason: string | null = null;
        if (operation.delivery === "none") reason = "no delivery configured";
        else if (i.conflictOpen !== null)
          reason = `conflict mission ${i.conflictOpen} open`;
        else if (probe?.state === "closed") reason = "pull request closed";
        // A PR that conflicts with the base gets no meaningful CI: Land opens the conflict mission instead of merging.
        const conflicting = probe?.mergeable === "conflict";
        const failingChecks = reason === null && !conflicting && probe?.checks === "fail" && !operation.ignoreChecks;
        if (failingChecks)
          reason = probe.failing?.length ? `failing check: ${probe.failing.join(", ")}` : "a required check failed";
        // A rerun turns red checks pending; landing then would merge before CI has said anything.
        else if (reason === null && !conflicting && probe?.checks === "pending" && !operation.ignoreChecks) reason = "checks still running";
        actions.push(view("land", "Land", true, reason === null, reason));
        // The operator can still land past red CI for this one PR; auto mode only looks at `land`.
        if (failingChecks) actions.push(view("land-anyway", "Land anyway", false, true));
        // Without a delivery the operator merges by hand; Mark done then verifies the merge actually happened.
        if (operation.delivery === "none")
          actions.push(view("done", "Mark done", false, true));
      } else {
        // Audits with nothing to merge and conflict missions never land: done is the exit.
        // A finished conflict mission is not the operator's next step: Land on the original is.
        actions.push(view("done", "Mark done", contact.kind !== "conflict", true));
      }
      // A finished pane that died still owns its PR: relaunching it is the only way back to Check PR.
      const relaunchable = terminal !== null && operation.frontend !== "none" && contact.lane?.frontend !== "external";
      if (owner === "offline" && carriesCode && probe?.state !== "merged" && relaunchable) actions.push(relaunch());
      actions.push(...fleetButtons().filter((b) => b.id === "check"), focus(), reap());
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

/**
 * Why the operator should leave this contact alone right now: the mission is working, or auto mode or
 * Recovery owns its next step. Null whenever it waits on a person: a question, a gate, a decision auto
 * mode does not make, red CI with no fix under way, or an automation switched off.
 */
export function handsOff(i: PolicyInput & { actions: ActionView[]; reviewStalled?: boolean }): string | null {
  const { operation, contact, state, status, owner, probe, actions } = i;
  const auto = operation.auto?.enabled ? operation.auto : null;
  const enabled = (id: string) => actions.some((a) => a.id === id && a.enabled);
  if (status?.hold === "question" || status?.hold === "gate" || status?.hold === "quota" || status?.hold === "blocked") return null;
  if (state === "decision") return i.decisionPaneOpen ? "An agent pane is deciding this" : null;
  if (state === "waiting") {
    const problem = missionProblem(status);
    if (problem?.retryAt) return `Retrying automatically at ${problem.retryAt.slice(11, 16)} UTC`;
    if (i.recoveryWait && operation.recover && i.recoveryWait.kind !== "refused") return "Recovery restarts this mission when it can";
    return null;
  }
  if (owner !== "live") return null;
  if (status?.hold === "resume") return operation.recover && status.verify !== "failed" ? "Recovery continues this mission" : null;
  if (status?.hold === "plan-approval") {
    if (!status.actions.includes("plan-approve")) return "Writing its plan";
    return auto?.plans ? "Auto mode approves this plan" : null;
  }
  if ((state === "planning" || state === "running" || state === "verify" || state === "review") && !i.reviewStalled &&
      !status?.actions.some((a) => a === "resend" || a === "review" || a === "continue"))
    return "Working on its own";
  if (state === "complete" && auto?.land && contact.kind !== "conflict") {
    if (probe?.checks === "pending") return "Waiting for CI; auto mode lands it when green";
    if (status?.check?.state === "fixing" && probe?.checks !== "fail") return "The mission is fixing its PR";
    if (enabled("land")) return "Auto mode lands this next";
    if (contact.kind === "audit" && enabled("done")) return "Auto mode marks this done, or opens a PR for its commits";
  }
  return null;
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
