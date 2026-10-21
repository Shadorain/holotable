import { el } from "./components.js";
import { icon } from "./icons.js";
import { modalButton, openModal } from "./modal.js";
import { capacityLabel, getModelCatalog, modelDropdown, suggestModel } from "./models.js";

let activeRecovery = null;
const recoveryAction = (contact) => contact.actions.find((action) => action.id === "retry-model");

export function modelRecoveryCandidate(contact) {
  return !!recoveryAction(contact) || !!contact.problem && /^(review|coordinator|worker(?:[: /]|$))/.test(contact.problem.source);
}

const PROBLEM = { quota: "Quota exhausted", "rate-limit": "Rate limited", timeout: "Timed out", error: "Failed" };
const shortModel = (selector) => String(selector ?? "").split("/").pop();

/** Why a mission cannot take a new model right now, or null when it can. */
function refusal(contact, busy) {
  if (busy?.has(`${contact.ticket}/*`)) return "Request already pending for this mission";
  const action = recoveryAction(contact);
  if (action?.enabled) return null;
  if (action?.reason) return action.reason;
  if (contact.state === "offline") return "Relaunch this pane first";
  if (contact.plan || contact.phase === "plan") return "Approve its plan first; the switch is offered once the mission runs";
  return "Clear its gate, resume or verification hold first, or relaunch an older mission pane";
}

/**
 * Switch the model of one or more failed missions and retry their failed work.
 * Flow: what failed (and on which model) → one picker, preset to a model with reported quota left → one button.
 * The dialog closes itself once every selected mission accepted the switch.
 */
export function openModelRecovery(contacts, { api, opId, run, busy }) {
  if (activeRecovery) {
    activeRecovery.box.querySelector("button")?.focus();
    return;
  }
  let closed = false;
  let running = false;
  let loaded = false;
  let chosenByOperator = false;
  const single = contacts.length === 1;
  const modal = openModal({ title: single ? `Switch model · ${contacts[0].ticket}` : "Switch models", onClose: () => { closed = true; activeRecovery = null; } });
  activeRecovery = modal;

  const list = el("div", "recovery-missions");
  const rows = contacts.map((contact) => {
    const why = refusal(contact, busy);
    const row = el(single ? "div" : "label", `recovery-mission${why ? " is-off" : ""}`);
    const check = el("input");
    check.type = "checkbox";
    check.checked = why === null;
    check.disabled = why !== null;
    check.setAttribute("aria-label", `Switch ${contact.ticket}`);
    const info = el("div", "recovery-info");
    const head = el("div", "recovery-head");
    head.append(el("strong", "mono", contact.ticket), el("span", "recovery-title", contact.title ?? ""));
    const facts = el("div", "recovery-facts");
    if (contact.model) facts.append(el("span", "recovery-chip", `on ${shortModel(contact.model)}`));
    if (contact.problem) facts.append(el("span", "recovery-chip warn", `${PROBLEM[contact.problem.kind] ?? "Failed"} · ${contact.problem.source}`));
    const result = el("div", "set-note", why ?? "");
    result.hidden = why === null;
    info.append(head, facts);
    if (contact.problem?.detail) {
      const details = el("details", "recovery-detail");
      details.append(el("summary", "", "What failed"), el("pre", "", contact.problem.detail));
      info.append(details);
    }
    info.append(result);
    if (!single) row.append(check);
    row.append(info);
    list.append(row);
    check.addEventListener("change", update);
    return { contact, check, result, eligible: why === null, done: false };
  });

  const hint = el("p", "set-note recovery-hint", "Loading models…");
  const picker = modelDropdown({
    api, value: null, allowOmpDefault: false, label: "New model", placeholder: "Choose a model",
    onChange: () => {
      chosenByOperator = true;
      describe();
      update();
      // The pick is the decision; Enter now confirms. After the dropdown hands focus back to its button.
      setTimeout(() => { if (!apply.disabled) apply.focus(); }, 0);
    },
  });
  const field = el("div", "modal-field recovery-field");
  field.append(el("span", "modal-label", single ? "Switch to" : "Switch the checked missions to"), picker.root, hint);
  const note = el("p", "set-note recovery-note", "Retries only the failed work. Running workers, finished reviews, claims and edits stay; gates and holds are not cleared.");
  const error = el("p", "set-error");
  error.hidden = true;

  const apply = modalButton("Switch & retry", { kind: "primary", iconName: "rotate-cw" });
  const selected = () => rows.filter((row) => row.check.checked && row.eligible && !row.done);
  function update() {
    const count = selected().length;
    apply.disabled = running || !loaded || !picker.value || count === 0;
    apply.lastChild.textContent = running ? "Switching…" : !single && count > 1 ? `Switch ${count} & retry` : "Switch & retry";
  }

  let catalog = null;
  let suggestion = null;
  function describe() {
    if (!catalog) return;
    if (catalog.error) {
      hint.textContent = `Models unavailable: ${catalog.error}`;
      return;
    }
    const picked = catalog.models?.find((m) => m.selector === picker.value);
    if (picked && picked.selector === suggestion?.selector && !chosenByOperator)
      hint.replaceChildren(icon("sparkles", { size: 12 }), document.createTextNode(` Suggested: the same model on ${picked.provider}, ${capacityLabel(picked.capacity)}.`));
    else if (picked) hint.textContent = picked.capacity?.state === "available" || picked.capacity?.state === "low" ? "" : "No quota report for this subscription; it may be limited too.";
    else hint.textContent = catalog.usageError ? "No quota report, so capacity is unknown: a model on another subscription is the safer pick." : "Pick the model to retry with.";
  }

  apply.addEventListener("click", async () => {
    if (running || apply.disabled) return;
    running = true;
    error.hidden = true;
    const targets = selected();
    const model = picker.value;
    picker.setDisabled(true);
    rows.forEach((row) => { row.check.disabled = true; });
    update();
    try {
      const fresh = await getModelCatalog(api);
      const choice = fresh.models?.find((entry) => entry.selector === model);
      if (!choice) throw new Error(fresh.error ?? "That model is no longer available. Choose another.");
      if (choice.capacity?.state === "exhausted") throw new Error("That subscription is exhausted. Choose another model.");
      for (const row of targets) {
        if (closed) break;
        row.result.hidden = false;
        row.result.textContent = `Switching to ${shortModel(model)}…`;
        let result;
        try { result = await run(row.contact.ticket, "retry-model", { model }, opId); }
        catch (err) { result = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
        row.done = result.ok;
        row.result.textContent = result.ok ? `Retrying on ${shortModel(model)}` : `Not switched: ${result.error}`;
        if (result.ok) row.check.checked = false;
      }
      // Every selected mission took the switch: nothing left to do here; the board toasts each one.
      if (!closed && targets.every((row) => row.done)) modal.close();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
      error.hidden = false;
    } finally {
      running = false;
      if (!closed) {
        picker.setDisabled(false);
        rows.forEach((row) => { row.check.disabled = !row.eligible || row.done; });
        update();
      }
    }
  });

  modal.step([list, field, note, error], [modalButton("Cancel", { onClick: modal.close }), apply], picker.btn);
  update();

  const applyCatalog = (next) => {
    catalog = next;
    picker.setCatalog(next);
    loaded = !next.error;
    let suggested = false;
    if (!chosenByOperator && !picker.value) {
      suggestion = suggestModel(next, contacts.map((c) => c.model));
      if (suggestion) {
        picker.setValue(suggestion.selector);
        suggested = true;
      }
    }
    describe();
    update();
    // With a suggestion in place, one Enter confirms it.
    if (suggested && !apply.disabled) apply.focus();
  };
  void getModelCatalog(api).then(async (first) => {
    if (closed) return;
    applyCatalog(first);
    if (first.error) return;
    if (!picker.value) hint.textContent = "Checking subscription quotas…";
    const withUsage = await getModelCatalog(api, { includeUsage: true });
    if (!closed) applyCatalog(withUsage);
  });
}
