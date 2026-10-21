// Projects: the top of the board. Each project is one repo and the wiring its operations
// start from; this page lists them with their operations and creates new ones.
import { el, textField } from "./components.js";
import { field } from "./fields.js";
import { icon } from "./icons.js";
import { projectFields } from "./projectform.js";
import { fetchJson, needsYou, storeErrorText } from "./ui.js";

function opChip(o, ctx) {
  const b = el("button", "proj-chip");
  b.type = "button";
  b.dataset.key = `projects/op/${o.id}`;
  b.title = `Open ${o.name}`;
  b.append(el("span", "", o.name));
  if (o.attention) b.append(el("span", "proj-chip-need", needsYou(o.attention)));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.openOperation(o.id);
  });
  return b;
}

function newProjectForm(ctx, onDone) {
  const box = el("section", "opdoc-sec proj-new");
  const head = el("div", "group-head");
  head.append(el("span", "", "New project"));
  box.append(head, el("div", "set-note sec-note", "Pick the repo; the base branch and wiring are read from it. Adjust anything before creating."));
  const pf = projectFields(ctx.defaults, ctx.api);
  box.append(pf.box);
  const name = textField({ label: "Name", placeholder: "filled from the repo", spellcheck: false });
  const nameF = field(box, "Name", name.root, { note: "Shown in the header and the operation picker." });
  let nameTouched = false;
  name.input.addEventListener("input", () => {
    nameTouched = true;
  });
  pf.box.addEventListener("detected", (e) => {
    if (!nameTouched) name.input.value = e.detail.name ?? "";
  });
  const err = el("div", "set-err");
  err.hidden = true;
  const actions = el("div", "list-tools left");
  const cancel = el("button", "btn small", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => onDone(null));
  const create = el("button", "btn small primary");
  create.type = "button";
  create.append(icon("plus", { size: 12 }), document.createTextNode("Create project"));
  create.addEventListener("click", async () => {
    if (create.disabled) return;
    create.disabled = true;
    err.hidden = true;
    nameF.setError(null);
    pf.clearErrors();
    try {
      await pf.ready();
      const settings = pf.read();
      if (!settings) return;
      const body = { ...settings };
      if (name.input.value.trim()) body.name = name.input.value.trim();
      const data = await ctx.api("/api/projects", { method: "POST", body: JSON.stringify(body) }).then(fetchJson);
      ctx.toast(`Project ${data.id} created`, "ok");
      onDone(data.id);
    } catch (error) {
      err.hidden = false;
      err.textContent = storeErrorText(error);
    } finally {
      create.disabled = false;
    }
  });
  actions.append(cancel, create);
  box.append(err, actions);
  queueMicrotask(() => pf.picker.input.focus());
  return box;
}

/** `projects`: GET /api/projects rows; `operations`: GET /api/operations rows (live counts). */
export function renderProjects(root, projects, operations, ctx) {
  root.replaceChildren();
  const head = el("div", "opdoc-head");
  head.append(el("h1", "opdoc-title", "Projects"));
  const add = el("button", "btn small primary");
  add.type = "button";
  add.dataset.key = "projects/new";
  add.append(icon("plus", { size: 12 }), document.createTextNode("New project"));
  head.append(add);
  root.append(head, el("div", "set-note", "A project is one repo and the wiring its operations start from. Operations inherit its settings and override only what differs."));

  if (ctx.onboarding) root.append(ctx.onboarding);
  const formSlot = el("div");
  root.append(formSlot);
  const showForm = () => {
    add.hidden = true;
    formSlot.replaceChildren(
      newProjectForm(ctx, (made) => {
        formSlot.replaceChildren();
        add.hidden = false;
        if (made) ctx.openProject(made);
      }),
    );
  };
  add.addEventListener("click", showForm);
  if (!projects || projects.error) {
    const err = el("div", "bad-text", projects?.error ? `Cannot load projects: ${projects.error}` : "Loading projects…");
    if (projects?.error) {
       const retry = el("button", "btn small", "Retry");
       retry.type = "button";
       retry.onclick = () => ctx.reload();
       err.append(retry);
    }
    root.append(err);
    return;
  }

  const byId = new Map(operations.map((o) => [o.id, o]));
  const grid = el("div", "proj-grid");
  for (const pr of projects) {
    const card = el("div", "proj-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.dataset.key = `projects/${pr.id}`;
    card.title = `Open project ${pr.name}: settings and operations`;
    const top = el("div", "proj-card-head");
    top.append(icon("folder", { size: 14 }), el("span", "proj-card-name", pr.name));
    const need = pr.operations.reduce((n, o) => n + (byId.get(o.id)?.attention ?? 0), 0);
    if (need) top.append(el("span", "proj-chip-need", needsYou(need)));
    card.append(top, el("div", "mono set-note", `${pr.repo} · ${pr.base}`));
    const chips = el("div", "proj-chips");
    if (!pr.operations.length) chips.append(el("span", "set-note", "No open operations"));
    for (const o of pr.operations) chips.append(opChip(byId.get(o.id) ?? { ...o, attention: 0 }, ctx));
    card.append(chips);
    card.addEventListener("click", () => ctx.openProject(pr.id));
    card.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === card) {
        e.preventDefault();
        e.stopPropagation();
        ctx.openProject(pr.id);
      }
    });
    grid.append(card);
  }
  if (!projects.length) grid.append(el("div", "empty-line", "No projects yet. Create one, or start a standalone operation from the picker."));
  root.append(grid);

  const standalone = operations.filter((o) => !o.project);
  if (standalone.length) {
    const sec = el("section", "opdoc-sec");
    const h = el("div", "group-head");
    h.append(el("span", "", "Standalone operations"));
    const chips = el("div", "proj-chips");
    for (const o of standalone) chips.append(opChip(o, ctx));
    sec.append(h, el("div", "set-note sec-note", "Operations with their own repo and wiring. Attach one to a project from its Operation page."), chips);
    root.append(sec);
  }
  if (ctx.autoNew) queueMicrotask(showForm);
}
