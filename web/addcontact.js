// "Add contact": one dialog for tickets that turn up mid-operation (triage, follow-ups).
// POST /api/contacts queues it as an operator addition; nothing launches until you click.
import { combobox, dropdown, el, textField } from "./components.js";
import { modalButton, openModal } from "./modal.js";
import { fetchJson, storeErrorText } from "./ui.js";

const KINDS = [
  ["implement", "Implement", "A mission builds and delivers it"],
  ["audit", "Audit", "A mission reviews; you mark it done"],
  ["decision", "Decision", "No mission: you decide and mark it decided"],
  ["closer", "Closer", "Last: once everything else lands, a mission reviews the integrated work and fixes small problems"],
];

function row(label, control, note) {
  const box = el("div", "modal-field");
  box.append(el("span", "modal-label", label), control);
  if (note) box.append(el("span", "set-note", note));
  return box;
}

export function openAddContact(projection, ctx) {
  const op = projection.operation;
  const modal = openModal({ title: `Add a contact to ${op.name}` });
  if (!op.zones.length) {
    modal.step(
      [el("p", "", "This operation has no zones yet. Add one on its Operation page (Plan → Operation), then add contacts.")],
      [modalButton("Close", { onClick: modal.close })],
    );
    return;
  }
  const tracked = op.tracker !== "none";
  const title = textField({ label: "Title", placeholder: tracked ? "Optional: the tracker's title" : "Short title", spellcheck: false });
  const description = el("textarea", "plan-edit contact-desc-edit");
  description.rows = 4;
  description.placeholder = "Full task scope, acceptance criteria, or context (optional)";
  description.setAttribute("aria-label", "Description");
  description.spellcheck = false;
  const existing = new Set(projection.contacts.map((c) => c.ticket));
  const ticket = combobox({
    label: "Ticket",
    mono: true,
    placeholder: tracked ? `Search ${op.tracker}, or type an id` : "short-slug",
    minChars: tracked ? 2 : Infinity,
    debounce: 250,
    loading: `Searching ${op.tracker}…`,
    empty: `Nothing in ${op.tracker} matches; you can still add the id as typed.`,
    source: async (q) => {
      const res = await ctx.api(`/api/tracker/search?op=${encodeURIComponent(op.id)}&q=${encodeURIComponent(q)}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Search failed (HTTP ${res.status})`);
      const items = (data.hits ?? []).map((h) => ({
        value: h.ticket,
        label: `${h.ticket}  ${h.title}`,
        title: h.title,
        meta: h.taken || existing.has(h.ticket) ? "already here" : (h.state ?? ""),
        disabled: Boolean(h.taken || existing.has(h.ticket)),
        hint: h.url ?? undefined,
      }));
      return { items, note: data.error ? `${op.tracker} search unavailable: ${data.error}` : "" };
    },
    onPick: (it) => {
      ticket.input.value = it.value;
      if (!title.input.value.trim()) title.input.value = it.title;
    },
  });
  const zone = dropdown({ label: "Zone", options: op.zones.map((z) => ({ value: z.id, label: z.label })), value: op.zones[0].id });
  // Decision contacts may list their options and a recommended one (auto mode can take it).
  const optionsText = el("textarea", "plan-edit");
  optionsText.rows = 3;
  optionsText.placeholder = "One option per line (optional)";
  optionsText.setAttribute("aria-label", "Options");
  const recommended = dropdown({ label: "Recommended", options: [{ value: "", label: "None" }], value: "" });
  const optionLines = () => [...new Set(optionsText.value.split("\n").map((s) => s.trim()).filter(Boolean))];
  optionsText.addEventListener("input", () => {
    const keep = optionLines().includes(recommended.value) ? recommended.value : "";
    recommended.setOptions([{ value: "", label: "None" }, ...optionLines().map((o) => ({ value: o, label: o }))], keep);
  });
  const decideBox = el("div", "modal-grid decide-only");
  decideBox.hidden = true;
  const hasCloser = projection.contacts.some((c) => c.kind === "closer");
  const kind = dropdown({
    label: "Kind",
    options: KINDS.map(([value, label, hint]) =>
      value === "closer" && hasCloser
        ? { value, label, hint: "An operation has at most one closer", meta: "already has one", disabled: true }
        : { value, label, hint }),
    value: "implement",
    onChange: (v) => {
      decideBox.hidden = v !== "decision";
      // A closer waits for everything on its own; it gets CLOSER unless the operator names it.
      waits.hidden = v === "closer";
      if (v === "closer" && !ticket.input.value.trim()) ticket.input.value = "CLOSER";
    },
  });
  // Waits for: picked from this operation's contacts, shown as removable chips.
  const chosen = [];
  const chips = el("div", "chips-input");
  const waitPick = combobox({
    anchor: chips,
    label: "Waits for",
    placeholder: "Search this operation's contacts",
    minChars: 0,
    debounce: 0,
    empty: "No other contacts match",
    source: (q) => {
      const needle = q.toLowerCase();
      return projection.contacts
        .filter((c) => !chosen.includes(c.ticket))
        .filter((c) => !needle || c.ticket.toLowerCase().includes(needle) || (c.title ?? "").toLowerCase().includes(needle))
        .slice(0, 30)
        .map((c) => ({ value: c.ticket, label: c.title ? `${c.ticket} · ${c.title}` : c.ticket, meta: c.state }));
    },
    onPick: (it) => {
      chosen.push(it.value);
      waitPick.input.value = "";
      drawChips();
      waitPick.refresh();
    },
  });
  function drawChips() {
    for (const c of [...chips.querySelectorAll(".chip-x")]) c.remove();
    for (const t of chosen) {
      const chip = el("span", "chip-x mono", t);
      const x = el("button", "", "×");
      x.type = "button";
      x.setAttribute("aria-label", `Remove ${t}`);
      x.addEventListener("click", () => {
        chosen.splice(chosen.indexOf(t), 1);
        drawChips();
      });
      chip.append(x);
      chips.insertBefore(chip, waitPick.root);
    }
  }
  waitPick.input.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !waitPick.input.value && chosen.length) {
      chosen.pop();
      drawChips();
    }
  });
  chips.append(waitPick.root);
  // The whole box is the field: a click beside the chips lands in the input.
  chips.addEventListener("click", (e) => {
    if (e.target === chips) waitPick.input.focus();
  });
  const err = el("div", "set-err");
  err.hidden = true;

  const ticketRow = row("Ticket", ticket.root, tracked ? `Pick from ${op.tracker}; the title fills in.` : "Any short id.");
  const ticketErr = el("span", "set-err", "Pick or type a ticket");
  ticketErr.hidden = true;
  ticketRow.append(ticketErr);
  const grid = el("div", "modal-grid");
  grid.append(ticketRow, row("Title", title.root), row("Zone", zone.root), row("Kind", kind.root));
  const descRow = row("Description", description);
  const waits = row("Waits for", chips, "It stays queued until these land.");
  decideBox.append(row("Options", optionsText, "Two or more, for a pick-one decision."), row("Recommended", recommended.root, "Auto mode takes it when deciding is automated."));

  const add = modalButton("Add contact", { kind: "primary", iconName: "plus" });
  const submit = async () => {
    err.hidden = true;
    ticketErr.hidden = true;
    if (!ticket.input.value.trim()) {
      ticketErr.hidden = false;
      ticket.input.focus();
      return;
    }
    add.disabled = true;
    const blockedBy = kind.value === "closer" ? [] : [...chosen];
    try {
      const data = await fetchJson(await ctx.api("/api/contacts", {
        method: "POST",
        body: JSON.stringify({
          op: op.id,
          ticket: ticket.input.value.trim(),
          zone: zone.value,
          kind: kind.value,
          title: title.input.value.trim() || undefined,
          description: description.value.trim() || undefined,
          blockedBy: blockedBy.length ? blockedBy : undefined,
          ...(kind.value === "decision" && optionLines().length
            ? { options: optionLines(), ...(recommended.value ? { recommended: recommended.value } : {}) }
            : {}),
        }),
      }));
      modal.close();
      ctx.toast(`${data?.ticket ?? "Contact"} queued`, "ok");
      ctx.added?.(data?.ticket);
    } catch (error) {
      err.hidden = false;
      err.textContent = storeErrorText(error);
      add.disabled = false;
    }
  };
  add.addEventListener("click", submit);
  // Enter submits from plain fields, and from a combobox only when its list is closed (else it picks).
  for (const input of [ticket.input, title.input, waitPick.input])
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.defaultPrevented && input.getAttribute("aria-expanded") !== "true") {
        e.preventDefault();
        submit();
      }
    });
  description.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });
  modal.step([grid, descRow, decideBox, waits, err], [modalButton("Cancel", { onClick: modal.close }), add], ticket.input);
}

/** Small "+ Add contact" button for list and map headers. */
export function addContactButton(onClick, label = "Add contact") {
  const b = modalButton(label, { iconName: "plus" });
  b.classList.add("small", "add-contact");
  b.title = "Queue a new ticket in this operation (triage, follow-ups)";
  b.addEventListener("click", onClick);
  return b;
}
