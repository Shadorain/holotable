// Operation page (Plan view → "Operation" sub-tab): the operation as a document.
// Brief, setup fields, the auto-mode card, zones and contacts, the checklist and the
// seed file — everything the old settings drawer's per-operation section held, plus
// brief/seed which only the page can show well. Field edits save through
// POST /api/operation-config; zone/contact adds are POST /api/zones|contacts.
import { dropdown, el, numberField, switcher, textField } from "./components.js";
import { enumRow, field, switchRow, textRow } from "./fields.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { endSection } from "./endop.js";
import { addContactButton } from "./addcontact.js";
import { notesPanel } from "./notes.js";
import { kindPill, openTicket, statePill } from "./ui.js";

const titleCase = (kind) => `${kind[0].toUpperCase()}${kind.slice(1)}`;

const WORKSPACE_SOURCE = {
  "orca-project": "from the Orca project",
  operation: "set on this operation",
  settings: "from worktrees.root",
  none: "not decided by holotable",
};

// Brief editing and zone filter, keyed by operation so a poll cannot eat them.
const briefUi = new Map();
const zoneFilter = new Map();
const briefState = (opId) => {
  let s = briefUi.get(opId);
  if (!s) {
    s = { editing: false, draft: "", error: null, saving: false, addingZone: false };
    briefUi.set(opId, s);
  }
  return s;
};
function selectedZone(opId, zones) {
  const id = zoneFilter.get(opId);
  if (!id) return null;
  if (zones && !zones.some((z) => z.id === id)) {
    zoneFilter.delete(opId);
    return null;
  }
  return id;
}
/** Digest for region(): rebuild when brief UI or the zone filter changes. */
export function opUiKey(opId, zones) {
  const s = briefUi.get(opId);
  return JSON.stringify([s?.editing, s?.saving, s?.addingZone, s?.error, s?.zoneError, selectedZone(opId, zones)]);
}

function docSection(title) {
  const box = el("section", "opdoc-sec");
  const head = el("div", "group-head");
  head.append(el("span", "", title));
  box.append(head);
  return box;
}

function briefSection(p, doc, ctx) {
  const opId = p.operation.id;
  const ui = briefState(opId);
  const box = docSection("Brief");
  const head = box.querySelector(".group-head");

  const editBtn = el("button", "btn small");
  editBtn.type = "button";
  editBtn.append(icon("pencil", { size: 12 }), document.createTextNode(doc.brief ? "Edit" : "Write"));
  editBtn.dataset.key = "op/brief-edit";
  editBtn.addEventListener("click", () => {
    ui.editing = true;
    ui.draft = doc.brief ?? "";
    ui.error = null;
    ctx.rerender();
  });
  if (!ui.editing) head.append(editBtn);

  if (ui.editing) {
    const area = el("textarea", "plan-edit brief-edit");
    area.value = ui.draft;
    area.placeholder = "# What this operation is about\nContext for the people and missions working it.";
    area.setAttribute("aria-label", "Operation brief");
    area.dataset.key = "op/brief-text";
    area.disabled = ui.saving;
    area.addEventListener("input", () => {
      ui.draft = area.value;
    });
    box.append(area);
    const row = el("div", "actions plan-row");
    const save = el("button", "btn small primary");
    save.type = "button";
    save.append(icon("save", { size: 12 }), document.createTextNode("Save"));
    save.dataset.key = "op/brief-save";
    save.disabled = ui.saving;
    if (ui.saving) save.setAttribute("aria-busy", "true");
    save.addEventListener("click", async () => {
      if (ui.saving) return;
      ui.saving = true;
      save.disabled = true;
      save.setAttribute("aria-busy", "true");
      area.disabled = true;
      cancel.disabled = true;
      ui.error = null;
      try {
        const res = await ctx.api("/api/brief", {
          method: "PUT",
          body: JSON.stringify({ op: opId, text: area.value }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
        ui.editing = false;
        ctx.toast("Brief saved", "ok");
        await ctx.reloadOp();
      } catch (error) {
        ui.error = error instanceof Error ? error.message : String(error);
      } finally {
        ui.saving = false;
        save.disabled = false;
        save.removeAttribute("aria-busy");
        area.disabled = false;
        cancel.disabled = false;
        ctx.rerender();
      }
    });
    const cancel = el("button", "btn small", "Cancel");
    cancel.type = "button";
    cancel.disabled = ui.saving;
    cancel.addEventListener("click", () => {
      ui.editing = false;
      ui.draft = "";
      ui.error = null;
      ctx.rerender();
    });
    row.append(save, cancel);
    box.append(row);
    if (ui.error) box.append(el("div", "set-err", ui.error));
    return box;
  }

  if (doc.brief) box.append(renderMarkdown(doc.brief));
  else box.append(el("div", "empty-line", "No brief yet — one paragraph on what this operation is for helps everyone reading the board."));
  return box;
}

/** Marks a row whose value comes from the project, with a way back after an override. */
function inheritance(f, key, cfg, ctx) {
  if (!cfg.fields.project) return;
  const headRow = f.row.querySelector(".set-field-head");
  if (cfg.inherited?.includes(key)) {
    const tag = el("span", "tag-inherit", "from project");
    tag.title = "Inherited from the project; changing it here overrides it for this operation only";
    headRow.append(tag);
  } else {
    const back = el("button", "linkish tag-inherit", "use project value");
    back.type = "button";
    back.title = "Drop this operation's override and follow the project again";
    back.addEventListener("click", () => ctx.saveOp(key, "inherit"));
    headRow.append(back);
  }
}

const OVERRIDE_KEYS = ["base", "integration", "pause", "tracker", "fleet", "frontend", "delivery", "worktreeRoot"];
let setupOpen = false;

function setupSection(p, doc, ctx) {
  const cfg = doc.cfg;
  const of = cfg.fields;
  const box = docSection("Setup");
  const projects = ctx.projects ?? [];
  const pick = dropdown({
    label: "Project",
    options: [...projects.map((pr) => ({ value: pr.id, label: pr.name })), { value: "", label: "No project (standalone)" }],
    value: of.project ?? "",
    onChange: (v) => ctx.saveOp("project", v),
  });
  const projRow = el("div", "set-inline");
  projRow.append(pick.root);
  if (of.project) {
    const open = el("button", "btn small");
    open.type = "button";
    open.append(icon("layers", { size: 12 }), document.createTextNode("Project settings"));
    open.addEventListener("click", () => ctx.openProject(of.project));
    projRow.append(open);
  }
  field(box, "Project", projRow, {
    note: of.project
      ? "Repo, base and wiring come from the project; change them on the project page. Detaching copies the project's values in."
      : "Standalone: this operation carries its own repo and wiring.",
  });

  textRow(box, "Name", "name", of.name, ctx.saveOp);

  // With a project, per-operation overrides are the exception: fold them behind a summary.
  const body = el("div", "setup-body");
  if (of.project) {
    const overridden = OVERRIDE_KEYS.filter((k) => !cfg.inherited?.includes(k));
    const toggle = el("button", "linkish setup-toggle");
    toggle.type = "button";
    toggle.dataset.key = "op/setup-overrides";
    const label = () =>
      `${setupOpen ? "Hide" : "Show"} settings · ${overridden.length ? `${overridden.length} overridden here (${overridden.join(", ")})` : "all from the project"}`;
    toggle.append(icon("chevron-down", { size: 12 }), document.createTextNode(label()));
    body.hidden = !setupOpen;
    toggle.classList.toggle("open", setupOpen);
    toggle.addEventListener("click", () => {
      setupOpen = !setupOpen;
      body.hidden = !setupOpen;
      toggle.classList.toggle("open", setupOpen);
      toggle.lastChild.textContent = label();
    });
    box.append(toggle);
  }
  box.append(body);

  const grid = el("div", "set-grid");
  inheritance(textRow(grid, "Base branch", "base", of.base, ctx.saveOp, { mono: true }), "base", cfg, ctx);
  inheritance(
    textRow(grid, "Integration checkout", "integration", of.integration, ctx.saveOp, { mono: true, note: "Where Land merges; must be on the base branch, with no uncommitted changes in the merge's paths." }),
    "integration",
    cfg,
    ctx,
  );
  inheritance(switchRow(grid, "Pause gates", "pause", of.pause, ctx.saveOp, { note: "Missions stop at each Pause gate for your approval." }), "pause", cfg, ctx);
  body.append(grid);
  const ports = el("div", "set-grid ports-grid");
  for (const kind of ["tracker", "fleet", "frontend", "delivery"])
    inheritance(enumRow(ports, titleCase(kind), kind, cfg.options[kind], of[kind], ctx.saveOp), kind, cfg, ctx);
  body.append(ports);
  inheritance(switchRow(body, "Land with failing checks", "ignoreChecks", of.ignoreChecks, ctx.saveOp, { note: "Land and auto mode merge PRs even when CI checks are red. Off: Land waits for green, and each card still offers Land anyway. GitHub branch protection still applies." }), "ignoreChecks", cfg, ctx);
  inheritance(
    textRow(body, "Worktree folder", "worktreeRoot", of.worktreeRoot, ctx.saveOp, {
      mono: true,
      placeholder: "use the board default",
      note: "Only for lanes holotable creates itself (herdr, custom).",
    }),
    "worktreeRoot",
    cfg,
    ctx,
  );
  const w = cfg.workspace;
  const ws = el("div", "set-workspace");
  if (w.path) ws.append(el("span", "mono", `${w.path} · ${WORKSPACE_SOURCE[w.source] ?? w.source}`));
  if (w.note) ws.append(el("div", "set-note", w.note));
  if (!w.path && !w.note) ws.append(el("span", "set-note", "No lane folder applies."));
  body.append(ws);
  return box;
}

function autoSection(p, ctx) {
  const box = docSection("Auto mode");
  const auto = "auto" in p.operation ? p.operation.auto : null;
  const card = el("div", "auto-card");

  let swField;
  const sw = switcher({
    label: "Auto mode",
    checked: Boolean(auto?.enabled),
    onChange: (v) => {
      swField.setError(null);
      ctx.saveOp("auto", v ? "on" : "off", (error) => {
        if (error) {
          sw.setChecked(Boolean(auto?.enabled));
          swField.setError(error);
        } else ctx.rerender();
      });
    },
  });
  swField = field(card, "Run the board itself", sw.root, {
    note: "Launch the queue and land finished work without a click each time.",
  });
  if (auto?.enabled) {
    if (auto.capacityWait) card.append(el("p", "set-note", auto.capacityWait));
    if (auto.landWait) card.append(el("div", "set-note", `Landing waiting · ${auto.landWait}`));
    const sub = el("div", "auto-sub");
    switchRow(sub, "Launch", "auto.launch", auto.launch, ctx.saveOp, {
      note: "Start queued contacts when a slot is free.",
    });
    switchRow(sub, "Land", "auto.land", auto.land, ctx.saveOp, {
      note: "Merge contacts when they complete.",
    });
    {
      const nf = numberField({ label: "Max live", value: auto.maxLive, min: 1, max: 8 });
      const f = field(sub, "Max live in this operation", nf.root, {
        note: "Below the board-wide cap.",
      });
      nf.input.addEventListener("change", () => {
        f.setError(null);
        ctx.saveOp("auto.maxLive", nf.input.value, (error) => {
          if (error) {
            nf.input.value = String(auto.maxLive);
            f.setError(error);
          }
        });
      });
    }
    card.append(sub);

    // Riskier automation, off by default: each one replaces a human judgement.
    const judge = el("div", "auto-sub auto-judge");
    switchRow(judge, "Decide", "auto.decide", Boolean(auto.decide), ctx.saveOp, {
      note: "Decision contacts take their recommended answer; without one, an omp pane investigates, records a choice with its reasoning, and closes. You can change any decision later.",
    });
    switchRow(judge, "Approve plans", "auto.plans", Boolean(auto.plans), ctx.saveOp, {
      note: "Approve native plan reviews automatically with compacted context. Requires OMP 18.10.4 or newer in each mission pane; older running panes must be relaunched. Pause gates still wait for you.",
    });
    switchRow(judge, "Extra repair cycle", "auto.repairs", Boolean(auto.repairs), ctx.saveOp, {
      note: "Authorize one additional repair cycle per contact after the mission's native budget is exhausted. Only confirmed findings qualify; decision escalations, quota holds and Pause gates still wait for you. Requires a newly started mission pane.",
    });
    switchRow(judge, "Request reviews", "auto.reviews", Boolean(auto.reviews), ctx.saveOp, {
      note: "Switch each running mission from Auto to Force once, so it requests its own independent review after delivery instead of waiting for your Review click. Costs a reviewer run per mission. Pause missions, and a mission you set back to Auto, are left alone.",
    });
    card.append(judge);
  }
  box.append(card);
  return box;
}

function recoverSection(p, ctx) {
  const box = docSection("Recovery");
  const card = el("div", "auto-card");
  switchRow(card, "Keep missions running", "recover", Boolean(p.operation.recover), ctx.saveOp, {
    note: "When a mission pane closes or crashes, reopen it in the same worktree and take the mission back (/mission continue). Never after failed verification, never past a gate or plan, never after you Reap; gives up after 3 reopens in 30 minutes.",
  });
  box.append(card);
  return box;
}

function zonesContactsSection(p, ctx) {
  const box = docSection("Zones and contacts");
  const zones = p.operation.zones;
  const opId = p.operation.id;
  const active = selectedZone(opId, zones);

  const zoneRow = el("div", "zone-chips");
  const all = el("button", "tag zone-chip");
  all.type = "button";
  all.dataset.key = "op/zone/all";
  all.setAttribute("aria-pressed", String(!active));
  all.textContent = "All";
  all.title = "Show every zone";
  all.addEventListener("click", () => {
    if (!zoneFilter.has(opId)) return;
    zoneFilter.delete(opId);
    ctx.rerender();
  });
  zoneRow.append(all);
  for (const z of zones) {
    const count = p.contacts.filter((c) => c.zone === z.id).length;
    const on = active === z.id;
    const chip = el("button", "tag zone-chip");
    chip.type = "button";
    chip.dataset.key = `op/zone/${z.id}`;
    chip.dataset.zone = z.id;
    chip.setAttribute("aria-pressed", String(on));
    chip.textContent = `${z.label} · ${count}`;
    chip.title = on ? "Show every zone" : `Show only ${z.label}`;
    chip.addEventListener("click", () => {
      if (zoneFilter.get(opId) === z.id) zoneFilter.delete(opId);
      else zoneFilter.set(opId, z.id);
      ctx.rerender();
    });
    zoneRow.append(chip);
  }
  if (zones.length) box.append(zoneRow);

  // Add zone.
  const zlabel = textField({ label: "New zone", placeholder: "Zone name, e.g. Billing", spellcheck: false });
  const zerr = el("div", "set-err");
  zerr.hidden = true;
  const zbtn = el("button", "btn small");
  zbtn.type = "button";
  zbtn.append(icon("plus", { size: 12 }), document.createTextNode("Add zone"));
  zbtn.dataset.key = "op/add-zone";
  const zoneUi = briefState(p.operation.id);
  zbtn.disabled = zoneUi.addingZone;
  zlabel.input.disabled = zoneUi.addingZone;
  if (zoneUi.addingZone) zbtn.setAttribute("aria-busy", "true");
  zerr.hidden = !zoneUi.zoneError;
  zerr.textContent = zoneUi.zoneError ?? "";
  zbtn.addEventListener("click", async () => {
    if (zoneUi.addingZone) return;
    zoneUi.addingZone = true;
    zbtn.disabled = true;
    zbtn.setAttribute("aria-busy", "true");
    zlabel.input.disabled = true;
    zoneUi.zoneError = null;
    zerr.hidden = true;
    try {
      const res = await ctx.api("/api/zones", {
        method: "POST",
        body: JSON.stringify({ op: p.operation.id, label: zlabel.input.value.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      zlabel.input.value = "";
      ctx.toast("Zone added", "ok");
      await ctx.poll();
    } catch (error) {
      zerr.hidden = false;
      zerr.textContent = error instanceof Error ? error.message : String(error);
      zoneUi.zoneError = zerr.textContent;
    } finally {
      zoneUi.addingZone = false;
      zbtn.disabled = false;
      zbtn.removeAttribute("aria-busy");
      zlabel.input.disabled = false;
      ctx.rerender();
    }
  });
  const zform = el("div", "inline-form");
  zlabel.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") zbtn.click();
  });
  zform.append(zlabel.root, zbtn);
  box.append(zform, zerr);

  // Contacts table. Ticket opens the tracker issue, not the delivery pull request.
  const table = el("div", "ctable");
  const headRow = el("div", "ctable-row ctable-head");
  for (const h of ["Ticket", "Title", "Zone", "Kind", "State", "Waits for"]) headRow.append(el("span", "", h));
  table.append(headRow);
  const zoneLabel = (id) => zones.find((z) => z.id === id)?.label ?? id;
  const shown = active ? p.contacts.filter((c) => c.zone === active) : p.contacts;
  for (const c of shown) {
    const row = el("div", "ctable-row");
    const tk = el("button", "linkish mono", c.ticket);
    tk.type = "button";
    tk.dataset.key = `op/contact/${c.ticket}`;
    tk.title = p.operation.tracker === "none" ? "This operation has no tracker" : `Open ${c.ticket} at its tracker`;
    tk.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openTicket(c, p.operation.tracker, (text) => ctx.toast(text, "error"), ctx.ticketUrl);
    });
    const kind = el("span", "");
    kind.append(kindPill(c.kind));
    row.append(tk, el("span", "ctable-title", c.title ?? "—"), el("span", "", zoneLabel(c.zone)), kind);
    const st = el("span", "");
    st.append(statePill(c));
    row.append(st);
    const waits = c.blockedBy.filter((b) => !b.landed).map((b) => b.ticket).join(", ");
    row.append(el("span", "dim", waits || "—"));
    table.append(row);
  }
  if (!p.contacts.length) table.append(el("div", "empty-line", "No contacts yet."));
  else if (!shown.length) table.append(el("div", "empty-line", "No contacts in this zone."));
  box.append(table);

  const addRow = el("div", "list-tools");
  addRow.append(addContactButton(() => ctx.addContact()));
  box.append(addRow);
  return box;
}

function seedSection(doc, p) {
  const box = docSection("Seed file");
  if (!doc.seed) {
    box.append(el("div", "empty-line", "This operation was created without a seed file."));
    return box;
  }
  const row = el("div", "actions plan-row");
  const dl = el("button", "btn small");
  dl.type = "button";
  dl.append(icon("download", { size: 12 }), document.createTextNode("Download seed.json"));
  dl.addEventListener("click", () => {
    const blob = new Blob([doc.seed.text], { type: "application/json" });
    const a = el("a", "");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.operation.id}.seed.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  row.append(dl);
  const det = el("details", "fold seed-fold");
  const summary = el("summary", "group-head");
  summary.append(el("span", "", "Raw JSON"));
  let pretty = doc.seed.text;
  try {
    pretty = JSON.stringify(JSON.parse(doc.seed.text), null, 2);
  } catch {
    // Not JSON after all: show it as stored.
  }
  det.append(summary, el("pre", "md-code seed-pre", pretty));
  box.append(row, det);
  return box;
}

export function renderOperation(root, projection, doc, ctx) {
  root.replaceChildren();
  const p = projection;
  const head = el("div", "opdoc-head");
  head.append(el("h1", "opdoc-title", p.operation.name), el("span", "mono opdoc-id", p.operation.id));
  if (p.operation.auto?.enabled) {
    const badge = el("span", "auto-ind");
    badge.append(icon("bot", { size: 12 }), document.createTextNode("Auto mode on"));
    head.append(badge);
  }
  root.append(head);

  if (!doc) {
    root.append(el("div", "empty-line", "Loading…"));
    return;
  }
  if (doc.error) {
    root.append(el("div", "set-err big", doc.error));
    return;
  }
  const notes = docSection("Notes");
  const n = p.notes;
  if (n?.total) notes.querySelector(".group-head").append(el("span", "count", `${n.done}/${n.total} done`));
  notes.append(notesPanel(p.operation.id, ctx));
  root.append(briefSection(p, doc, ctx), notes, autoSection(p, ctx), recoverSection(p, ctx), setupSection(p, doc, ctx), zonesContactsSection(p, ctx));

  root.append(seedSection(doc, p), endSection(p, ctx));
  const created = el("div", "set-note opdoc-created");
  created.textContent = doc.createdAt ? `Created ${new Date(doc.createdAt).toLocaleString()}` : "";
  root.append(created);
}
