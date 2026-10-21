import { clearCardDecision, clearDecideModel, clearLaunchModel, getCardDecision, getDecideModel, getLaunchModel } from "./card.js";
import { openDecide } from "./decide.js";
import { openModelRecovery } from "./model-recovery.js";
import { CONFIRM } from "./ui.js";

const PAST = {
  launch: "launched", land: "landed", "land-anyway": "landed past failing checks", approve: "approved", continue: "continued", review: "sent to review",
  dispatch: "dispatched", check: "PR check started", done: "marked done", reap: "terminal closed", focus: "focused", mode: "mode changed",
  "plan-save": "plan saved", "plan-refine": "refinement sent to the mission", answer: "question answered",
  relaunch: "reopened", redecide: "decision changed", "decide-agent": "agent asked to decide",
  resend: "worker retry requested", release: "blocker release requested", "retry-model": "switched model and retrying",
};

/**
 * Board actions over the page's shared state.
 * `pollFresh` must resolve after a poll that started once any in-flight one finished.
 */
export function createActions({ state, api, toast, render, pollFresh }) {
  let confirmTimer = null;

  /** Runs one board action; resolves `{ok, error}` so callers like the plan editor can react. */
  async function runAction(ticket, action, args = {}, opId = state.opId) {
    const key = `${opId}/${ticket}/${action}`;
    const lock = `${opId}/${ticket}/*`;
    if (state.busy.has(lock)) return { ok: false, error: "Request already pending for this mission" };
    state.busy.add(key);
    state.busy.add(lock);
    render();
    let outcome;
    try {
      const res = await api("/api/actions", {
        method: "POST",
        body: JSON.stringify({ op: opId, contact: ticket, action, args }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        outcome = { ok: false, error: body?.error ?? `HTTP ${res.status}` };
        toast(`${ticket ? `${ticket}: ` : ""}${action} failed. ${outcome.error}`, "error");
      } else {
        outcome = { ok: true, error: null };
        toast(`${ticket} ${PAST[action] ?? action}`, "ok");
      }
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      toast(`${action} failed: ${outcome.error}`, "error");
    } finally {
      try {
        await pollFresh();
      } finally {
        state.busy.delete(key);
        state.busy.delete(lock);
        render();
      }
    }
    return outcome;
  }

  function confirmOrRun(ticket, action) {
    const opId = state.opId;
    const key = `${ticket}/${action}`;
    if (state.busy.has(`${opId}/${ticket}/*`)) return;
    // Recording a decision needs the choice (and maybe why), so it opens a dialog first.
    const contact = state.projection?.contacts.find((c) => c.ticket === ticket);
    if (action === "retry-model" && contact) {
      openModelRecovery([contact], { api, opId, run: runAction });
      return;
    }
    if (contact?.kind === "decision" && (action === "done" || action === "redecide")) {
      const initialChoice = action === "done" ? getCardDecision(opId, ticket) : null;
      openDecide(contact, action, async (args) => {
        const res = await runAction(ticket, action, args, opId);
        if (res.ok) clearCardDecision(opId, ticket);
        return res;
      }, { initialChoice });
      return;
    }
    if (CONFIRM[action] && state.confirming !== key) {
      state.confirming = key;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => {
        state.confirming = null;
        render();
      }, 4000);
      render();
      return;
    }
    const args = {};
    if (action === "launch") {
      const model = getLaunchModel(opId, ticket);
      if (model !== undefined) args.model = model;
    } else if (action === "decide-agent") {
      const model = getDecideModel(opId, ticket);
      if (model !== undefined) args.model = model;
    }
    state.confirming = null;
    runAction(ticket, action, args, opId).then((res) => {
      if (res?.ok) {
        if (action === "launch") clearLaunchModel(opId, ticket);
        if (action === "decide-agent") clearDecideModel(opId, ticket);
      }
    });
  }

  return { runAction, confirmOrRun };
}
