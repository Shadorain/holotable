// Recording a decision: one dialog for "Mark decided" and "Change decision". With options the
// operator picks one (explicitly for a new decision); without, they type the answer.
// Either way the reasoning is optional and kept on the contact.
import { el, textField } from "./components.js";
import { icon } from "./icons.js";
import { modalButton, openModal } from "./modal.js";

/** `contact`: ContactView; `action`: "done" | "redecide"; `run(args)` returns {ok, error}. */
export function openDecide(contact, action, run, { initialChoice = null } = {}) {
  const changing = action === "redecide";
  const modal = openModal({ title: changing ? `Change the decision on ${contact.ticket}` : `Decide ${contact.ticket}` });
  const question = el("p", "decide-q", contact.title ?? contact.ticket);
  const options = contact.options ?? [];
  const current = contact.decision?.choice ?? null;

  // Explicit choice required for new decisions; changing preserves current choice.
  // An explicit initialChoice preselects that option without recording it.
  let choice = null;
  if (initialChoice && (!options.length || options.includes(initialChoice))) {
    choice = initialChoice;
  } else if (changing && current && (!options.length || options.includes(current))) {
    choice = current;
  }

  const validRec =
    typeof contact.recommended === "string" && contact.recommended.length > 0 && (!options.length || options.includes(contact.recommended))
      ? contact.recommended
      : null;

  const err = el("div", "set-err");
  err.hidden = true;

  const body = [question];
  let updateRecBtn = null;
  let recBtn = null;

  if (validRec) {
    const recBar = el("div", "decide-rec");
    const recInfo = el("div", "decide-rec-info");
    recInfo.append(
      el("span", "decide-rec-kicker", "Recommended"),
      el("span", "decide-rec-val", validRec)
    );
    recBtn = el("button", "btn small decide-rec-btn");
    recBtn.type = "button";
    recBtn.append(icon("sparkles", { size: 13 }), document.createTextNode("Pick recommended"));
    recBtn.setAttribute("aria-label", `Pick recommended: ${validRec}`);

    updateRecBtn = (currentVal) => {
      recBtn.setAttribute("aria-pressed", String(currentVal === validRec));
    };

    recBar.append(recInfo, recBtn);
    body.push(recBar);
  }

  const radios = [];
  let free = null;

  if (options.length) {
    const list = el("fieldset", "decide-opts");
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", "Choice");

    const select = (value) => {
      choice = value;
      err.hidden = true;
      for (const r of radios) r.checked = r.value === value;
      updateRecBtn?.(value);
    };

    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const optId = `decide-opt-${i}-${Math.random().toString(36).slice(2, 6)}`;
      const row = el("label", "decide-opt");
      row.htmlFor = optId;

      const radio = el("input", "decide-radio");
      radio.type = "radio";
      radio.id = optId;
      radio.name = `decide-choice-${contact.ticket}`;
      radio.value = option;
      radios.push(radio);

      const dot = el("span", "decide-dot");
      dot.setAttribute("aria-hidden", "true");

      const label = el("span", "decide-label", option);

      row.append(radio, dot, label);
      if (option === contact.recommended) row.append(el("span", "tag tag-recommended", "recommended"));
      if (option === current) row.append(el("span", "tag tag-current", "current"));

      radio.addEventListener("change", () => {
        if (radio.checked) select(option);
      });

      // Only intercept Enter; native arrow keys navigate the radio group.
      radio.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save.click();
        }
      });

      list.append(row);
    }

    if (choice !== null) {
      select(choice);
    } else {
      updateRecBtn?.(null);
    }

    if (recBtn) {
      recBtn.addEventListener("click", () => {
        const idx = options.indexOf(validRec);
        if (idx !== -1 && radios[idx]) {
          radios[idx].focus();
        }
        select(validRec);
      });
    }

    body.push(list);
  } else {
    free = textField({ label: "Decision", placeholder: "What was decided, in a line", spellcheck: true });
    free.input.value = current ?? (initialChoice ?? "");
    const wrap = el("label", "modal-field");
    wrap.append(el("span", "modal-label", "Decision"), free.root);
    body.push(wrap);

    free.input.addEventListener("input", () => {
      err.hidden = true;
      updateRecBtn?.(free.input.value.trim());
    });

    free.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save.click();
      }
    });

    if (recBtn) {
      recBtn.addEventListener("click", () => {
        free.input.value = validRec;
        free.input.focus();
        err.hidden = true;
        updateRecBtn(validRec);
      });
      updateRecBtn(free.input.value.trim());
    }
  }

  const why = el("textarea", "plan-edit decide-why");
  why.rows = 4;
  why.placeholder = "Why (optional): kept with the decision for whoever reads it later";
  why.setAttribute("aria-label", "Reasoning");
  if (changing && contact.decision?.rationale) {
    why.value = contact.decision.rationale;
  }
  const whyWrap = el("label", "modal-field");
  whyWrap.append(el("span", "modal-label", "Reasoning"), why);
  body.push(whyWrap);

  if (contact.decision) {
    const prev = el("div", "set-note", `Current: ${contact.decision.choice}${contact.decision.by !== "operator" ? ` (by ${contact.decision.by === "agent" ? "an agent" : "the recommendation"})` : ""}`);
    body.push(prev);
  }
  body.push(err);



  const setDisabled = (disabled) => {
    save.disabled = disabled;
    for (const r of radios) r.disabled = disabled;
    if (recBtn) recBtn.disabled = disabled;
    why.disabled = disabled;
    if (free) free.input.disabled = disabled;
  };

  let submitting = false;
  const save = modalButton(changing ? "Change decision" : "Mark decided", { kind: "primary", iconName: "check-check" });
  save.addEventListener("click", async () => {
    if (submitting) return;
    const value = free ? free.input.value.trim() : choice;
    if (!value) {
      err.hidden = false;
      err.textContent = free ? "Write what was decided." : "Choose an option.";
      return;
    }
    submitting = true;
    setDisabled(true);
    err.hidden = true;
    try {
      const args = { choice: value };
      if (why.value.trim()) args.rationale = why.value.trim();
      const res = await run(args);
      if (res.ok) {
        modal.close();
      } else {
        setDisabled(false);
        submitting = false;
        err.hidden = false;
        err.textContent = res.error ?? "Failed to record decision.";
      }
    } catch (error) {
      setDisabled(false);
      submitting = false;
      err.hidden = false;
      err.textContent = error instanceof Error ? error.message : String(error);
    }
  });

  let initialFocus = null;
  if (free) {
    initialFocus = free.input;
  } else if (options.length) {
    if (choice !== null && options.includes(choice)) {
      initialFocus = radios[options.indexOf(choice)];
    } else if (recBtn) {
      initialFocus = recBtn;
    } else {
      initialFocus = radios[0];
    }
  }

  modal.step(body, [modalButton("Cancel", { onClick: modal.close }), save], initialFocus);
}
