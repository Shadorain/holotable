// Recording a decision: one dialog for "Mark decided" and "Change decision". With options the
// operator picks one (the recommended one preselected); without, they type the answer.
// Either way the reasoning is optional and kept on the contact.
import { el, textField } from "./components.js";
import { modalButton, openModal } from "./modal.js";

/** `contact`: ContactView; `action`: "done" | "redecide"; `run(args)` returns {ok, error}. */
export function openDecide(contact, action, run) {
  const changing = action === "redecide";
  const modal = openModal({ title: changing ? `Change the decision on ${contact.ticket}` : `Decide ${contact.ticket}` });
  const question = el("p", "decide-q", contact.title ?? contact.ticket);
  const options = contact.options ?? [];
  const current = contact.decision?.choice ?? null;
  let choice = current ?? contact.recommended ?? null;

  const body = [question];
  let free = null;
  if (options.length) {
    const list = el("div", "decide-opts");
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", "Choice");
    const rows = [];
    const select = (value) => {
      choice = value;
      for (const r of rows) r.setAttribute("aria-checked", String(r.dataset.value === value));
      for (const r of rows) r.tabIndex = r.dataset.value === value ? 0 : -1;
    };
    for (const option of options) {
      const row = el("button", "decide-opt");
      row.type = "button";
      row.setAttribute("role", "radio");
      row.dataset.value = option;
      row.append(el("span", "decide-dot"), el("span", "decide-label", option));
      if (option === contact.recommended) row.append(el("span", "tag", "recommended"));
      if (option === current) row.append(el("span", "tag", "current"));
      row.addEventListener("click", () => select(option));
      row.addEventListener("keydown", (e) => {
        const i = options.indexOf(option);
        const next = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
        if (!next) return;
        e.preventDefault();
        const to = options[(i + next + options.length) % options.length];
        select(to);
        rows[options.indexOf(to)].focus();
      });
      rows.push(row);
      list.append(row);
    }
    select(choice ?? options[0]);
    body.push(list);
  } else {
    free = textField({ label: "Decision", placeholder: "What was decided, in a line", spellcheck: true });
    free.input.value = current ?? "";
    const wrap = el("label", "modal-field");
    wrap.append(el("span", "modal-label", "Decision"), free.root);
    body.push(wrap);
  }
  const why = el("textarea", "plan-edit decide-why");
  why.rows = 4;
  why.placeholder = "Why (optional): kept with the decision for whoever reads it later";
  why.setAttribute("aria-label", "Reasoning");
  const whyWrap = el("label", "modal-field");
  whyWrap.append(el("span", "modal-label", "Reasoning"), why);
  body.push(whyWrap);
  if (contact.decision) {
    const prev = el("div", "set-note", `Current: ${contact.decision.choice}${contact.decision.by !== "operator" ? ` (by ${contact.decision.by === "agent" ? "an agent" : "the recommendation"})` : ""}`);
    body.push(prev);
  }
  const err = el("div", "set-err");
  err.hidden = true;
  body.push(err);

  const save = modalButton(changing ? "Change decision" : "Mark decided", { kind: "primary", iconName: "check-check" });
  save.addEventListener("click", async () => {
    const value = free ? free.input.value.trim() : choice;
    if (free && !value) {
      err.hidden = false;
      err.textContent = "Write what was decided.";
      return;
    }
    save.disabled = true;
    const args = { choice: value };
    if (why.value.trim()) args.rationale = why.value.trim();
    const res = await run(args);
    if (res.ok) modal.close();
    else {
      save.disabled = false;
      err.hidden = false;
      err.textContent = res.error;
    }
  });
  modal.step(body, [modalButton("Cancel", { onClick: modal.close }), save], free?.input ?? body[1]?.querySelector?.('[aria-checked="true"]'));
}
