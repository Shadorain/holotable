import { el } from "./components.js";
import { modalButton, openModal } from "./modal.js";
import { getModelCatalog, modelDropdown } from "./models.js";


let activeRecovery = null;
const recoveryAction = (contact) => contact.actions.find((action) => action.id === "retry-model");

export function modelRecoveryCandidate(contact) {
  return !!recoveryAction(contact) || !!contact.problem && /^(review|coordinator|worker(?:[: /]|$))/.test(contact.problem.source);
}

export function openModelRecovery(contacts, { api, opId, run, busy }) {
  if (activeRecovery) {
    activeRecovery.box.querySelector("button")?.focus();
    return;
  }
  let closed = false;
  let running = false;
  let loaded = false;
  const modal = openModal({ title: contacts.length === 1 ? `Recover ${contacts[0].ticket}` : "Recover failed missions", onClose: () => { closed = true; activeRecovery = null; } });
  activeRecovery = modal;
  const explanation = el("p", "set-note", "Set the mission model and retry failed work only. Running workers stay untouched; future workers and reviews use your choice. Finished review targets, bead claims and edits are retained. Gates and verification holds are not cleared. Closing stops unsent retries, not work already accepted.");
  const list = el("div", "recovery-missions");
  const rows = contacts.map((contact) => {
    const action = recoveryAction(contact);
    const pending = busy?.has(`${contact.ticket}/*`);
    const eligible = action?.enabled === true && !pending;
    const label = el("label", "recovery-mission");
    const check = el("input");
    check.type = "checkbox";
    check.checked = eligible;
    check.disabled = !eligible;
    check.setAttribute("aria-label", `Retry ${contact.ticket}`);
    const info = el("div");
    const reason = pending ? "Request already pending for this mission" : action?.reason ?? (contact.state === "offline" ? "Relaunch this pane first" : contact.plan || contact.phase === "plan" ? "Approve its plan first; recovery starts once the mission runs" : "Recovery unavailable: clear any gate/resume/verification hold; reload an older mission pane to enable this control");
    const progress = contact.problem?.total == null ? "" : ` · ${contact.problem.completed}/${contact.problem.total} reviews retained`;
    const result = el("div", "set-note", eligible ? `${contact.problem?.source ?? "Failed work"}${progress}` : reason);
    info.append(el("strong", "", contact.ticket), el("div", "set-note", contact.problem?.detail ?? contact.detail), result);
    label.append(check, info);
    list.append(label);
    check.addEventListener("change", update);
    return { contact, check, result, eligible, done: false };
  });
  const notice = el("p", "set-note", "Loading available models…");
  const picker = modelDropdown({ api, value: null, allowOmpDefault: false, label: "Recovery model", placeholder: "Choose a recovery model", onChange: update });
  const field = el("div", "modal-field");
  field.append(el("span", "modal-label", "Use this model for selected missions"), picker.root, notice);
  const error = el("p", "set-error");
  error.hidden = true;
  const apply = modalButton("Switch model & retry", { kind: "primary", iconName: "rotate-cw" });
  const selected = () => rows.filter((row) => row.check.checked && row.eligible && !row.done);
  function update() {
    apply.disabled = running || !loaded || !picker.value || !selected().length;
  }
  apply.addEventListener("click", async () => {
    if (running || apply.disabled) return;
    running = true;
    apply.setAttribute("aria-busy", "true");
    apply.textContent = "Requesting…";
    error.hidden = true;
    const targets = selected();
    const model = picker.value;
    picker.setDisabled(true);
    rows.forEach((row) => { row.check.disabled = true; });
    update();
    try {
      const catalog = await getModelCatalog(api);
      const choice = catalog.models?.find((entry) => entry.selector === model);
      picker.setCatalog(catalog);
      if (!choice) throw new Error(catalog.error ?? "That model is no longer available. Refresh quotas and choose another.");
      if (choice.capacity?.state === "exhausted") throw new Error("That subscription is exhausted. Choose another model.");
      for (const row of targets) {
        if (closed) break;
        row.result.textContent = "Switching model and retrying…";
        let result;
        try { result = await run(row.contact.ticket, "retry-model", { model }, opId); }
        catch (err) { result = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
        row.done = result.ok;
        row.result.textContent = result.ok ? "Retry accepted — follow live mission progress" : `Not retried: ${result.error}`;
        if (result.ok) row.check.checked = false;
      }
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
      error.hidden = false;
    } finally {
      running = false;
      apply.removeAttribute("aria-busy");
      apply.textContent = "Switch model & retry";
      picker.setDisabled(false);
      rows.forEach((row) => { row.check.disabled = !row.eligible || row.done; });
      update();
    }
  });
  modal.step([explanation, list, field, error], [modalButton("Close", { onClick: modal.close }), apply], picker.btn);
  update();
  void getModelCatalog(api, { refresh: true }).then(async (catalog) => {
    if (closed) return;
    picker.setCatalog(catalog);
    loaded = !catalog.error;
    notice.textContent = catalog.error ?? "Models ready; checking subscription quotas… Unknown capacity is not a guarantee.";
    update();
    if (catalog.error) return;
    const capacity = await getModelCatalog(api, { refresh: true, includeUsage: true });
    if (closed) return;
    picker.setCatalog(capacity);
    notice.textContent = capacity.error ?? capacity.usageError ?? "Available subscriptions first; low balances marked; exhausted subscriptions disabled. Unknown capacity is not a guarantee.";
    update();
  });
}
