// A new operation: where (a project, or any repo, which becomes a project), what (a Linear
// link, issue links or a plan, drafted by an omp pane into zones, contacts, notes and a brief),
// a name, Create. The board opens the pane (POST /api/drafts) and you review its seed here;
// nothing is created until Create.
import { dropdown, el, switcher, textField } from "./components.js";
import { errorText, fetchJson, slug, storeErrorText } from "./ui.js";
import { field } from "./fields.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { openModal } from "./modal.js";
import { modelDropdown } from "./models.js";
import { projectFields } from "./projectform.js";

const NEW_REPO = "";

function section(title, note) {
  const box = el("section", "opdoc-sec");
  const h = el("div", "group-head");
  h.append(el("span", "", title));
  box.append(h);
  if (note) box.append(el("div", "set-note sec-note", note));
  return box;
}

/** Edit | Preview pair; `onMode(mode)` runs when the pressed one changes. */
function editPreviewToggle(className, onMode) {
  const box = el("div", className);
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Brief view");
  const buttons = [["edit", "Edit"], ["preview", "Preview"]].map(([mode, label]) => {
    const b = el("button", "btn small", label);
    b.type = "button";
    b.dataset.mode = mode;
    return b;
  });
  const paint = (mode) => {
    for (const b of buttons) {
      b.classList.toggle("active", b.dataset.mode === mode);
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    }
  };
  let current = "edit";
  paint(current);
  for (const b of buttons) {
    b.addEventListener("click", () => {
      if (b.dataset.mode === current) return;
      current = b.dataset.mode;
      paint(current);
      onMode(current);
    });
  }
  box.append(...buttons);
  return box;
}

// One listener for the page: the form re-renders with each region rebuild, so the latest
// render registers how to resume its draft polling when the tab comes back.
let resumeDraft = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeDraft?.();
});

/** ctx: { api, toast, defaults, projects, project?, draftText?, created(id), cancel() } */
export function renderNewOperation(root, ctx) {
  root.replaceChildren();
  const head = el("div", "opdoc-head");
  head.append(el("h1", "opdoc-title", "New operation"), el("span", "set-note", "Pick where, paste what, review, create. Everything can change later."));
  root.append(head);

  const projects = Array.isArray(ctx.projects) ? ctx.projects : [];

  // ---- 1. Where ----
  const where = section("1 · Where");
  const projectPick = dropdown({
    label: "Project",
    options: [...projects.map((p) => ({ value: p.id, label: `${p.name} · ${p.repo}` })), { value: NEW_REPO, label: "Another repo…" }],
    value: ctx.project ?? projects[0]?.id ?? NEW_REPO,
    onChange: () => syncWhere(),
  });
  field(where, "Project", projectPick.root, { note: "Repo, base branch and wiring come from the project." });
  const repoBox = el("div", "new-repo");
  const pf = projectFields(ctx.defaults, ctx.api);
  const keepProject = switcher({ label: "Save as a project", checked: true });
  repoBox.append(pf.box);
  field(repoBox, "Save as a project", keepProject.root, { note: "Recommended: the next operation on this repo starts from it. Off keeps the settings on this operation only." });
  where.append(repoBox);
  const frontendHint = el("div", "set-warn");
  frontendHint.hidden = true;
  where.append(frontendHint);
  root.append(where);

  // ---- 2. What ----
  const what = section("2 · What", "Paste a Linear document, ticket links, a plan or a rough goal. The agent drafts an execution plan for you to review.");
  const whatPanel = el("div", "what-panel");
  const draftText = el("textarea", "plan-edit");
  draftText.rows = 4;
  draftText.placeholder = "Paste a plan link, or describe the goal, constraints and what success looks like…";
  draftText.setAttribute("aria-label", "Link or plan for the agent");
  draftText.value = ctx.draftText ?? "";

  const draftToolbar = el("div", "draft-toolbar");
  const draftActions = el("div", "draft-actions");
  const draftBtn = el("button", "btn small primary");
  draftBtn.type = "button";
  draftBtn.append(icon("sparkles", { size: 12 }), document.createTextNode("Draft it"));

  let draftModelOverride;
  const draftModelDd = modelDropdown({
    api: ctx.api,
    value: null,
    allowInherit: true,
    inheritLabel: "Default model",
    label: "Model for draft",
    placeholder: "Model",
    className: "dd-model",
    onChange: (v) => {
      if (v === null) draftModelOverride = undefined;
      else draftModelOverride = v === "" ? null : v;
    },
  });

  draftActions.append(draftBtn, draftModelDd.root);
  const draftStatus = el("span", "draft-status");
  draftStatus.setAttribute("role", "status");
  draftStatus.setAttribute("aria-live", "polite");
  draftToolbar.append(draftActions, draftStatus);
  whatPanel.append(draftText, draftToolbar);
  what.append(whatPanel);
  root.append(what);

  // ---- 3. Review ----
  const review = section("3 · Review");
  const grid = el("div", "set-grid");
  const name = textField({ label: "Name", placeholder: "filled by the draft, or type one", spellcheck: false });
  const nameF = field(grid, "Name *", name.root, {});
  const idNote = el("div", "set-note");
  idNote.hidden = true;
  nameF.row.append(idNote);
  const syncId = () => {
    const id = slug(name.input.value);
    idNote.hidden = !id;
    idNote.replaceChildren("Id: ", el("span", "mono", id));
  };
  name.input.addEventListener("input", syncId);
  const recover = switcher({ label: "Keep missions running", checked: true });
  field(grid, "Keep missions running", recover.root, { note: "Reopen a pane that closes or crashes and take the mission back. Never past a gate, plan or failed verification." });
  review.append(grid);
  const briefWrap = el("div", "brief-wrap");
  const brief = el("textarea", "plan-edit brief-edit");
  brief.placeholder = "# What this operation is about\nOptional context for you and the missions.";
  brief.setAttribute("aria-label", "Brief");

  const briefPreview = el("div", "brief-preview");
  let briefMode = "edit";
  let briefUserEdited = false;
  let syncFocusedBrief = null;

  const syncBriefUI = () => {
    brief.hidden = briefMode !== "edit";
    briefPreview.hidden = briefMode !== "preview";
    if (briefMode === "preview") {
      briefPreview.replaceChildren(renderMarkdown(brief.value || "*Nothing to preview*"));
    }
  };
  brief.addEventListener("input", () => { briefUserEdited = true; });

  const focusBtn = el("button", "btn small");
  focusBtn.type = "button";
  focusBtn.append(icon("maximize-2", { size: 12 }), document.createTextNode("Review in focus"));
  focusBtn.addEventListener("click", () => {
    const modal = openModal({ title: "Review Brief", onClose: () => { syncFocusedBrief = null; } });
    modal.box.classList.add("brief-focus");
    const mBody = el("div", "brief-modal-body");
    const mArea = el("textarea", "plan-edit brief-modal-edit");
    mArea.value = brief.value;
    mArea.setSelectionRange(0, 0);
    mArea.setAttribute("aria-label", "Brief (focus view)");
    const mPreview = el("div", "brief-preview brief-modal-preview");
    mPreview.hidden = true;
    let mMode = "edit";
    let focusedBriefEdited = false;
    mArea.addEventListener("input", () => { focusedBriefEdited = true; });
    syncFocusedBrief = () => {
      if (!focusedBriefEdited) mArea.value = brief.value;
      if (mMode === "preview") mPreview.replaceChildren(renderMarkdown(mArea.value || "*Nothing to preview*"));
    };
    const mToggle = editPreviewToggle("brief-modal-toggle", (mode) => {
      mMode = mode;
      mArea.hidden = mode !== "edit";
      mPreview.hidden = mode !== "preview";
      if (mode === "edit") mArea.focus();
      else mPreview.replaceChildren(renderMarkdown(mArea.value || "*Nothing to preview*"));
    });
    mBody.append(mToggle, mArea, mPreview);

    const mSave = el("button", "btn primary", "Save and close");
    mSave.type = "button";
    mSave.addEventListener("click", () => {
      brief.value = mArea.value;
      briefUserEdited = true;
      syncBriefUI();
      modal.close();
    });

    const mCancel = el("button", "btn", "Cancel");
    mCancel.type = "button";
    mCancel.addEventListener("click", () => modal.close());

    modal.step([mBody], [mCancel, mSave], mArea);
  });

  const briefToolbar = el("div", "brief-toolbar");
  const briefToggle = editPreviewToggle("brief-toggle", (mode) => {
    briefMode = mode;
    syncBriefUI();
    if (mode === "edit") brief.focus();
  });
  briefToolbar.append(briefToggle, focusBtn);

  briefWrap.append(briefToolbar, brief, briefPreview);
  field(review, "Brief", briefWrap, { note: "Markdown, shown on the Operation page." });
  syncBriefUI();

  const seedSummary = el("div", "seed-summary set-note", "No contacts yet: draft them above, or add them on the board after creating.");
  const seedDetails = el("details", "seed-details");
  seedDetails.append(el("summary", "", "Zones, contacts and notes as JSON"));
  const seed = el("textarea", "plan-edit seed-edit mono");
  seed.placeholder = '{"zones": [{"id": "api", "label": "API"}], "contacts": [{"ticket": "CHR-1", "title": "Short title", "description": "Full task description", "zone": "api"}]}';
  seed.setAttribute("aria-label", "Seed JSON");
  seed.spellcheck = false;
  const seedErr = el("div", "set-err");
  seedErr.hidden = true;
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".json,application/json";
  fileInput.hidden = true;
  const upload = el("button", "btn small");
  upload.type = "button";
  upload.append(icon("upload", { size: 12 }), document.createTextNode("Load a file"));
  upload.addEventListener("click", () => fileInput.click());
  const seedRow = el("div", "notes-tools");
  seedRow.append(upload);
  seedDetails.append(seed, seedRow, seedErr);
  review.append(seedSummary, seedDetails, fileInput);
  root.append(review);

  /** Parses the JSON box: null when empty, the object when valid, undefined (and an error shown) when not. */
  function seedValue() {
    const text = seed.value.trim();
    seedErr.hidden = true;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      seedErr.hidden = false;
      seedErr.textContent = errorText(error);
      seedDetails.open = true;
      return undefined;
    }
  }
  function summarize() {
    const s = seedValue();
    if (!s) {
      seedSummary.textContent = s === null ? "No contacts yet: draft them above, or add them on the board after creating." : "The JSON below has an error.";
      return;
    }
    const contacts = s.contacts ?? [];
    const zones = s.zones ?? [];
    const decisions = contacts.filter((c) => c.kind === "decision").length;
    seedSummary.textContent = `${contacts.length} contact${contacts.length === 1 ? "" : "s"} in ${zones.length} zone${zones.length === 1 ? "" : "s"}${decisions ? `, ${decisions} decision${decisions === 1 ? "" : "s"}` : ""}${s.notes ? ", with notes" : ""}. Open the JSON to check or edit them.`;
  }
  seed.addEventListener("input", summarize);
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    seed.value = await f.text();
    summarize();
  });

  // ---- Create ----
  const err = el("div", "set-err big");
  err.hidden = true;
  const row = el("div", "actions opnew-actions");
  const create = el("button", "btn primary");
  create.type = "button";
  create.append(icon("file-plus-2", { size: 13 }), document.createTextNode("Create operation"));
  const cancel = el("button", "btn", "Cancel");
  cancel.type = "button";
  cancel.addEventListener("click", () => {
    void closeDraft();
    ctx.cancel();
  });
  row.append(create, cancel);
  root.append(err, row);

  // ---- Where: project or a new repo ----
  let madeProject = null; // a project created from the repo by Draft or Create; reused on retry
  const newRepo = () => projectPick.value === NEW_REPO;
  async function frontendOf(projectId) {
    try {
      return (await fetchJson(await ctx.api(`/api/project-config?project=${encodeURIComponent(projectId)}`))).fields.frontend;
    } catch {
      return null;
    }
  }
  function warnFrontend(frontend) {
    frontendHint.hidden = frontend !== "none";
    frontendHint.textContent = "This project has no terminal frontend, so the agent cannot draft and missions cannot launch. Set Orca, herdr or custom on the project page.";
  }
  async function syncWhere() {
    repoBox.hidden = !newRepo();
    if (newRepo()) warnFrontend(null);
    else warnFrontend(await frontendOf(projectPick.value));
  }
  pf.box.addEventListener("detected", (e) => warnFrontend(e.detail.frontend));
  void syncWhere();

  /** The project to draft or create in: the chosen one, or one made from the repo once. */
  async function ensureProject() {
    if (!newRepo()) return projectPick.value;
    if (madeProject) return madeProject;
    await pf.ready();
    const settings = pf.read();
    if (!settings) return null;
    madeProject = (await fetchJson(await ctx.api("/api/projects", { method: "POST", body: JSON.stringify(settings) }))).id;
    return madeProject;
  }

  // ---- Draft flow ----
  let draftId = null;
  let timer = null;
  async function closeDraft() {
    clearTimeout(timer);
    if (!draftId) return;
    const idNow = draftId;
    draftId = null;
    await ctx.api("/api/drafts/close", { method: "POST", body: JSON.stringify({ id: idNow }) }).catch(() => null);
  }
  function fillFromSeed(s) {
    if (s.name && !name.input.value.trim()) {
      name.input.value = s.name;
      syncId();
    }
    if (s.brief && !briefUserEdited) {
      brief.value = s.brief;
      syncBriefUI();
      syncFocusedBrief?.();
    }
    const body = { zones: s.zones ?? [], contacts: s.contacts ?? [] };
    if (s.notes) body.notes = s.notes;
    seed.value = JSON.stringify(body, null, 2);
    summarize();
  }
  let pollingDraft = false;
  async function pollDraft() {
    if (!draftId || pollingDraft) return;
    if (document.visibilityState !== "visible") return;
    pollingDraft = true;
    try {
      const data = await fetchJson(await ctx.api(`/api/drafts?id=${encodeURIComponent(draftId)}`));
      if (data.state === "ready") {
        fillFromSeed(data.seed);
        draftStatus.textContent = "Drafted. Review it below, then Create.";
        draftBtn.disabled = false;
        await closeDraft();
        return;
      }
      if (data.state === "missing") {
        draftStatus.textContent = "The draft pane closed before it wrote anything. Draft again to retry.";
        draftBtn.disabled = false;
        draftId = null;
        return;
      }
      draftStatus.textContent =
        data.state === "invalid" ? `Not valid yet: ${data.error ?? "unknown"} (the agent may still be fixing it)` : "The agent is reading and drafting in its pane…";
      if (document.visibilityState === "visible") {
        timer = setTimeout(pollDraft, 2500);
      }
    } catch (error) {
      draftStatus.textContent = `Draft failed: ${storeErrorText(error)}`;
      draftBtn.disabled = false;
      await closeDraft();
    } finally {
      pollingDraft = false;
    }
  }
  resumeDraft = () => {
    if (draftId && !pollingDraft) {
      clearTimeout(timer);
      timer = setTimeout(pollDraft, 500);
    }
  };
  async function startDraft() {
    const text = draftText.value.trim();
    if (!text) {
      draftStatus.textContent = "Paste a link or a plan first.";
      draftText.focus();
      return;
    }
    draftBtn.disabled = true;
    draftStatus.textContent = newRepo() && !madeProject ? "Saving the project…" : "Opening a pane…";
    try {
      const project = await ensureProject();
      if (!project) {
        draftBtn.disabled = false;
        draftStatus.textContent = "";
        return;
      }
      draftStatus.textContent = "Opening a pane…";
      const body = { text, project };
      if (draftModelOverride !== undefined) body.model = draftModelOverride;
      draftId = (await fetchJson(await ctx.api("/api/drafts", { method: "POST", body: JSON.stringify(body) }))).id;
      draftStatus.textContent = "The agent is reading and drafting in its pane…";
      timer = setTimeout(pollDraft, 2500);
    } catch (error) {
      draftStatus.textContent = storeErrorText(error);
      draftBtn.disabled = false;
    }
  }
  draftBtn.addEventListener("click", startDraft);

  create.addEventListener("click", async () => {
    if (create.disabled) return;
    err.hidden = true;
    nameF.setError(null);
    pf.clearErrors();
    const s = seedValue();
    if (s === undefined) return;
    const id = slug(name.input.value);
    if (!id) return nameF.setError(new Error("required"));
    const body = { id, name: name.input.value.trim(), recover: recover.root.getAttribute("aria-checked") === "true" };
    if (brief.value.trim()) body.brief = brief.value;
    if (s) body.seed = seed.value.trim();
    create.disabled = true;
    try {
      if (newRepo() && keepProject.root.getAttribute("aria-checked") !== "true" && !madeProject) {
        await pf.ready();
        const settings = pf.read();
        if (!settings) return;
        Object.assign(body, settings);
      } else {
        const project = await ensureProject();
        if (!project) return;
        body.project = project;
      }
      const data = await fetchJson(await ctx.api("/api/operations", { method: "POST", body: JSON.stringify(body) }));
      ctx.toast(`Operation ${data?.id ?? id} created`, "ok");
      ctx.created(data?.id ?? id);
    } catch (error) {
      err.hidden = false;
      err.textContent = storeErrorText(error);
    } finally {
      create.disabled = false;
    }
  });

  queueMicrotask(() => (newRepo() ? pf.picker.input : draftText).focus());
  if (ctx.draftText && !newRepo()) void startDraft();
}
