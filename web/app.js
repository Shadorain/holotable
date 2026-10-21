import { renderOps } from "./board.js";
import { cardTabs, planUiKey, renderCard } from "./card.js";
import { orderedTickets, renderList } from "./list.js";
import { drawLinks, renderHistory, renderMap } from "./plan.js";
import { createRadar } from "./radar.js";
import { createSettingsDrawer } from "./settings.js";
import { el, errorText, fetchJson, KEY_DIR, nearestInDirection, needsYou, openTicket } from "./ui.js";
import { dropdown, popoverOpenWithin } from "./components.js";
import { renderNewOperation } from "./newop.js";
import { opUiKey, renderOperation } from "./operation.js";
import { renderArchive } from "./archive.js";
import { renderProject } from "./project.js";
import { renderProjects } from "./projects.js";
import { gettingStarted, onboardingHidden, showOnboarding, startTour, tourPending } from "./onboarding.js";
import { openAddContact } from "./addcontact.js";
import { allLanded, doneBanner } from "./endop.js";
import { ensureNotes, notesKey } from "./notes.js";
import { icon } from "./icons.js";
import { installInbox } from "./inbox.js";
import { installTooltips } from "./tooltip.js";
import { installLoadTip } from "./usage.js";
import { connectLive } from "./live.js";
import { createActions } from "./actions.js";

installTooltips();


const $ = (id) => document.getElementById(id);

// Old /intel links get this page from the server: they open the Intel view, at the board's own address.
if (location.pathname === "/intel") {
  const params = new URLSearchParams(location.search);
  const op = params.get("op");
  const archive = params.get("archive");
  localStorage.setItem("holotable.view", "intel");
  localStorage.setItem("holotable.intelView", params.get("view") === "fleet" || (!op && !archive) ? "fleet" : "op");
  if (op) localStorage.setItem("holotable.op", op);
  if (archive) localStorage.setItem("holotable.intelArchive", archive);
  else localStorage.removeItem("holotable.intelArchive");
  history.replaceState(null, "", `/${location.hash}`);
}

// Token arrives in the URL fragment (never in a request line); keep it per tab, scrub the address bar.
const tokenKey = `holotable-token:${location.pathname}`;
const fragmentToken = location.hash.slice(1);
const token = fragmentToken || sessionStorage.getItem(tokenKey) || "";
if (fragmentToken) {
  sessionStorage.setItem(tokenKey, fragmentToken);
  history.replaceState(null, "", `${location.pathname}${location.search}`);
}

const state = {
  operations: [],
  projection: null,
  opId: localStorage.getItem("holotable.op") || "",
  view: ["board", "plan", "intel"].includes(localStorage.getItem("holotable.view")) ? localStorage.getItem("holotable.view") : "table",
  history: null,
  cardTab: ["details", "history"].includes(localStorage.getItem("holotable.cardTab")) ? localStorage.getItem("holotable.cardTab") : "overview",
  historyFilter: { contact: null, actor: "all", text: "" },
  selected: JSON.parse(localStorage.getItem("holotable.selected") || "{}"),
  busy: new Set(),
  confirming: null,
  conn: "connecting",
  planView: ["map", "op", "new"].includes(localStorage.getItem("holotable.planView")) ? localStorage.getItem("holotable.planView") : "map",
  intelView: localStorage.getItem("holotable.intelView") === "fleet" ? "fleet" : "op",
  intelArchive: localStorage.getItem("holotable.intelArchive"), // Intel only: a closed operation picked instead of an open one
  intelArchives: [], // GET /api/intel/sources archives, listed in the picker while Intel is shown
  archive: null, // GET /api/archive rows, or {error}
  projects: null, // GET /api/projects rows
  setup: undefined, // GET /api/setup: undefined = not asked, null = loading, {error} on failure
  projectId: null,
  projectCfg: null, // GET /api/project-config, or {error}
  archiveKey: null, // open report
  archiveReports: new Map(),
  opDoc: null,
  defaults: { tracker: "none", fleet: "omp-mission", frontend: "none", delivery: "none", pause: false },
};
const POLL_INTERVAL_MS = 3000;
// While the stream is connected the loop only covers what file watching cannot see.
const STREAM_FALLBACK_MS = 30_000;
let polling = false;
let refreshPending = false;
let pollDone = Promise.resolve();
let pollTimer = null;
let opDocPending = null;
let stream = null;

const api = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  headers.set("X-Holotable-Token", token);
  if (options.body) headers.set("Content-Type", "application/json");
  return fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
};
/** GET as JSON; a failure comes back as `{ error }` for the page to show. */
async function getJson(path) {
  try {
    return (await fetchJson(await api(path))) ?? { error: "Empty response" };
  } catch (error) {
    return { error: errorText(error) };
  }
}
/** POST a JSON body; throws the server's message on failure. */
async function postJson(path, body) {
  return fetchJson(await api(path, { method: "POST", body: JSON.stringify(body) }));
}
installLoadTip($("load").closest(".stat"), {
  api,
  opId: () => state.opId,
  sessions: () => ({ op: state.projection?.stats.omp.current ?? 0, all: state.projection?.header.open ?? 0 }),
  ops: () => state.operations.length,
});

// ---- toasts ----

const inbox = installInbox({
  button: $("inboxButton"),
  count: $("inboxCount"),
  panel: $("inbox"),
  list: $("inboxList"),
  clear: $("inboxClear"),
  fallbackFocus: $("settingsButton"),
});

function toast(text, kind = "info") {
  if (kind === "error") inbox.add(text);
  for (const existing of $("toasts").children) {
    if (existing.dataset.text === text && existing.dataset.kind === kind) {
      existing.remove();
      break;
    }
  }
  const box = el("div", `toast t-${kind}`);
  box.dataset.text = text;
  box.dataset.kind = kind;
  box.append(el("span", "", text));
  const close = el("button", "toast-x");
  close.append(icon("x", { size: 12 }));
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => box.remove());
  box.append(close);
  $("toasts").append(box);
  // Errors stay longer, and the inbox keeps them after the toast goes.
  setTimeout(() => box.remove(), kind === "error" ? 8000 : 4000);
  // Over the cap the oldest non-error goes first.
  const toasts = $("toasts");
  while (toasts.childElementCount > 4) {
    const oldest = [...toasts.children].find((t) => t.dataset.kind !== "error") ?? toasts.firstElementChild;
    oldest.remove();
  }
}

// ---- selection ----

const selectedTicket = () => state.selected[state.opId] ?? null;
function select(ticket, fromKey = false) {
  // In the plan, picking a contact also narrows its history; clicking it again widens it back.
  if (state.view === "plan") state.historyFilter.contact = !fromKey && state.historyFilter.contact === ticket ? null : ticket;
  state.selected[state.opId] = ticket;
  localStorage.setItem("holotable.selected", JSON.stringify(state.selected));
  render();
}

function storePlanView(view) {
  state.planView = view;
  localStorage.setItem("holotable.planView", view);
}

function storeIntelView(view) {
  state.intelView = view;
  localStorage.setItem("holotable.intelView", view);
}

function setIntelArchive(key) {
  state.intelArchive = key;
  if (key) localStorage.setItem("holotable.intelArchive", key);
  else localStorage.removeItem("holotable.intelArchive");
}

/** Point the page at another operation; everything loaded or pending for the old one is dropped. */
function switchOp(id) {
  state.opId = id;
  localStorage.setItem("holotable.op", id);
  state.opDoc = null;
  state.projection = null;
  state.history = null;
  state.historyFilter.contact = null;
  state.confirming = null;
}

// Table view centre: one radar instance for the session; update() replaces its data, never its canvas.
const radar = createRadar($("stage"), {
  onSelect: (ticket, event) => (event && (event.metaKey || event.ctrlKey) ? openTicketAtTracker(ticket) : select(ticket)),
});
const syncRadar = () => radar.setActive(state.view === "table" && document.visibilityState === "visible");


// Operation picker is one dropdown for the session; renderHeader() only feeds it options.
const opPick = dropdown({
  className: "op-dd",
  label: "Operation",
  placeholder: "No operations",
  reselect: true, // picking the current operation from Archive or a project page still opens it
  options: [],
  footers: [
    {
      label: "New operation",
      icon: "plus",
      onPick: () => {
        storePlanView("new");
        setView("plan");
      },
    },
    { label: "Archive", icon: "archive", onPick: () => setView("archive") },
  ],
  onChange: (value) => {
    if (value.startsWith("archive:")) {
      // Only Intel lists archives: picking one shows its frozen evidence.
      setIntelArchive(value.slice("archive:".length));
      storeIntelView("op");
      render();
    } else {
      switchOp(value);
      if (state.planView === "new") storePlanView("map");
      if (state.view === "intel") {
        setIntelArchive(null);
        storeIntelView("op");
      }
      // Archive and project pages are not about one operation; choosing one means "go look at it".
      if (state.view === "archive" || state.view === "project" || state.view === "projects") setView("board");
      poll();
    }
    // The picker refocuses itself on close, and a focused picker takes the view keys as type-ahead. A pick means
    // "go look at it", so hand the keys back to the board.
    setTimeout(() => opPick.btn.blur());
  },
});
$("op").append(opPick.root);

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("holotable.theme", theme);
}
let tourOffered = false; // the first-visit tour starts at most once per page load

/** Board-wide settings, and the defaults the new-operation and new-project forms start from. */
function applySettings(settings) {
  state.settings = settings;
  if (settings.defaults) state.defaults = { ...state.defaults, ...settings.defaults, ai: settings.ai };
}
const settingsDrawer = createSettingsDrawer({
  api,
  applyTheme,
  toast,
  settingsChanged: (settings) => {
    applySettings(settings);
    render();
  },
  openHelp: () => $("help").showModal(),
  openGuide: () => {
    showOnboarding();
    state.setup = undefined; // re-check the machine
    state.projects = null;
    setView("projects");
  },
  startTour: () => setTimeout(startTour, 250), // after the drawer has closed
});

/** Live theme while the page is up (drawer preview + settings file). */
async function loadTheme() {
  const data = await getJson("/api/settings");
  if (data.error) return;
  applyTheme(data.settings.theme);
  applySettings(data.settings);
}
loadTheme();

// ---- actions ----

const { runAction, confirmOrRun } = createActions({ state, api, toast, render, pollFresh });

// ---- rendering ----

/** Rebuild a region only when its inputs changed; keep keyboard focus on the same control. */
function region(root, data, build) {
  const sig = JSON.stringify(data);
  if (root.dataset.sig === sig) return;
  // An open dropdown's trigger lives in the region; rebuilding would orphan its popover,
  // so this region catches up on the next poll instead.
  if (popoverOpenWithin(root)) return;
  const active = document.activeElement;
  const inside = active && root.contains(active);
  if (inside && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
  const key = inside ? active.dataset.key : null;
  const scroll = root.scrollTop;
  root.dataset.sig = sig;
  build(root);
  root.scrollTop = scroll;
  if (key) root.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus();
}

let lastHeaderSig = "";
function renderHeader() {
  const p = state.projection;
  const current = state.operations.find((o) => o.id === state.opId);
  let shown = current?.project;
  if (state.view === "project" && state.projectId) shown = { id: state.projectId, name: state.projectCfg?.fields?.name ?? state.projectId };
  else if (state.view === "projects" || state.view === "archive" || state.intelArchive) shown = null;
  const needs = p ? p.contacts.filter((c) => c.attention).length : 0;
  const sig = JSON.stringify([
    state.operations.map((o) => [o.id, o.name, o.attention, o.project?.id, o.project?.name]),
    state.opId,
    state.view,
    shown,
    p ? [p.operation.base, p.header.open, p.header.cap, p.notes?.done, p.notes?.total, needs, p.operation.auto] : null,
    state.conn,
    state.intelArchive,
    state.view === "intel" ? state.intelArchives : null,
  ]);
  if (sig === lastHeaderSig) return;
  lastHeaderSig = sig;
  // Grouped by project; standalone operations come last under their own heading.
  const groups = new Map();
  for (const o of state.operations) {
    const key = o.project?.id ?? "";
    if (!groups.has(key)) groups.set(key, { name: o.project?.name ?? "Standalone", ops: [] });
    groups.get(key).ops.push(o);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return groups.get(a).name.localeCompare(groups.get(b).name);
  });
  const grouped = keys.length > 1 || keys[0] !== "";
  const options = [];
  for (const key of keys) {
    const g = groups.get(key);
    if (grouped) options.push({ value: `group:${key}`, label: g.name, group: true, disabled: true });
    for (const o of g.ops)
      options.push({ value: o.id, label: `${o.name}${o.attention ? ` · ${needsYou(o.attention)}` : ""}`, indent: grouped });
  }
  // Intel also reads closed operations' frozen evidence, so there the picker lists the archive too.
  if (state.view === "intel" && state.intelArchives.length) {
    options.push({ value: "archive:", label: "Archived operations", group: true, disabled: true });
    for (const a of state.intelArchives)
      options.push({ value: `archive:${a.key}`, label: a.name, meta: new Date(a.closedAt).toLocaleDateString(), indent: true });
  }
  const crumb = $("projectCrumb");
  crumb.hidden = !shown;
  if (shown) {
    crumb.lastChild.textContent = shown.name;
    crumb.title = `Project ${shown.name}: its settings and operations`;
    crumb.dataset.project = shown.id;
  }
  crumb.toggleAttribute("aria-current", state.view === "project");
  if (state.view === "project") crumb.setAttribute("aria-current", "page");
  $("projectsCrumb").toggleAttribute("aria-current", state.view === "projects");
  if (state.view === "projects") $("projectsCrumb").setAttribute("aria-current", "page");
  // In the Archive no open operation is in view: the picker says where you are instead.
  if (state.view === "archive") opPick.setOptions(options, null, "Archive");
  else if (state.intelArchive) opPick.setOptions(options, `archive:${state.intelArchive}`, "Select operation");
  else opPick.setOptions(options, state.opId, state.operations.length ? "Select operation" : "No operations");
  opPick.setDisabled(!options.length);
  document.querySelectorAll("#toggle button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === state.view)));
  $("base").textContent = p ? p.operation.base : "—";
  $("load").textContent = p ? `${p.header.open} / ${p.header.cap} omp` : "—";
  const fill = $("loadMeter").firstElementChild;
  fill.style.width = p ? `${Math.min(100, Math.round((p.header.open / p.header.cap) * 100))}%` : "0";
  $("loadMeter").classList.toggle("full", Boolean(p && p.header.open >= p.header.cap));
  // Notes without task lines are just notes: no counter to look at.
  $("tasksStat").hidden = !p?.notes?.total;
  if (p?.notes?.total) $("flows").textContent = `${p.notes.done} / ${p.notes.total}`;
  $("needs").hidden = needs === 0;
  $("needsText").textContent = needsYou(needs);
  $("conn").className = `conn c-${state.conn}`;
  $("connText").textContent = { live: "live", connecting: "connecting", lost: "reconnecting", denied: "token rejected" }[state.conn];
  const auto = p?.operation?.auto;
  $("autoInd").hidden = !auto?.enabled;
  $("autoText").textContent = auto?.enabled ? (auto.launch || auto.land ? "Auto" : "Auto (manual land)") : "";
  const intDirty = p?.operation?.integrationDirty;
  const dirty = typeof intDirty === "number" && intDirty > 0;
  $("intWarn").hidden = !dirty;
  $("intWarnText").textContent = dirty ? `integration dirty · ${intDirty}` : "";
  // Narrow screens fold the connection and the dirty warning behind More; its dot keeps them visible.
  $("moreButton").toggleAttribute("data-alert", state.conn !== "live" || dirty);
}
function showBlank(message, detail) {
  document.body.dataset.view = "blank";
  const blank = $("blank");
  blank.replaceChildren(el("h2", "", message), el("p", "", detail));
  blank.hidden = false;
  syncRadar();
}

function showPage(view, planView = null) {
  $("blank").hidden = true;
  document.body.dataset.view = view;
  if (planView) document.body.dataset.planview = planView;
  else delete document.body.dataset.planview;
}

// Views that need no open operation; the archive is about the ones that ended.
const PAGES = {
  projects: renderProjectsPage,
  project: renderProjectPage,
  archive: renderArchivePage,
  intel: renderIntelPage,
};

/** A dialog, drawer, popover or tour is up, or a field has focus: the board must not move the selection. */
function operatorBusy() {
  if (document.activeElement?.matches("input, textarea, select, [contenteditable]")) return true;
  return Boolean(document.querySelector(".modal-back, .settings:not([hidden]), [data-popover], .tour-card, dialog[open]"));
}

/** The history log is on screen: the plan map's side panel, or a card's History tab. */
function historyShown() {
  if (state.view === "plan") return state.planView === "map";
  return state.cardTab === "history" && (state.view === "board" || state.view === "table");
}

function render() {
  syncRadar();
  renderHeader();
  if (!token) return showBlank("No access token", "Open the full URL that /holotable printed in OMP (it ends in #<token>).");
  if (state.conn === "denied") return showBlank("Token rejected", "The board was restarted and has a new URL. Run /holotable in OMP and open the URL it prints.");
  if (state.conn === "live" && PAGES[state.view] && (state.view !== "project" || state.projectId)) {
    showPage(state.view);
    PAGES[state.view]();
    syncRadar();
    return;
  }
  if (!state.operations.length && state.conn === "live") {
    if (state.view === "plan" && state.planView === "new") {
      showPage("plan", "new");
      renderNewOp();
      return;
    }
    // Nothing to look at yet: the Projects page carries the getting-started guide.
    state.view = "projects";
    render();
    return;
  }
  const p = state.projection;
  if (!p) return;
  if (tourPending() && !tourOffered) {
    tourOffered = true;
    setTimeout(startTour, 800);
  }
  showPage(state.view, state.view === "plan" ? state.planView : null);
  // Default to what needs the operator first, not merely the first live contact.
  let selected = selectedTicket();
  let contact = p.contacts.find((c) => c.ticket === selected) ?? null;
  if (!contact) {
    state.selected[state.opId] = orderedTickets(p)[0] ?? p.selection;
    selected = selectedTicket();
    contact = p.contacts.find((c) => c.ticket === selected) ?? null;
  } else if (contact.state === "landed" && Date.now() - lastInteractionTime > 10000 && !operatorBusy()) {
    const first = p.contacts.find((c) => c.attention);
    if (first && first.ticket !== selected) {
      state.selected[state.opId] = first.ticket;
      selected = first.ticket;
      contact = first;
    }
  }
  const ctx = {
    opId: p.operation.id,
    ai: state.settings?.ai,
    busy: new Set([...state.busy].filter(key => key.startsWith(`${p.operation.id}/`)).map(key => key.slice(p.operation.id.length + 1))),
    confirming: state.confirming,
    run: runAction,
    openOperationPage: () => openOperationPage(),
    rerender: () => render(),
    addContact: () => addContact(p),
    endCtx: { api, toast, ended: opEnded },
    api,
    toast,
    notesChanged: () => poll(),
    showEvidence: (ticket) => {
      state.cardTab = "history";
      select(ticket);
      poll();
    },
    refreshPlan: async () => {
      if (contact) planCache.delete(`${p.operation.id}/${contact.ticket}`);
      await poll();
      render();
    },
  };
  const busy = [...ctx.busy];
  if (state.view === "board" || (state.view === "plan" && state.planView === "op")) ensureNotes(p.operation.id, p.notes, api, render);

  region($("list"), { op: p.operation.id, contacts: p.contacts, zones: p.operation.zones, selected, busy, c: state.confirming }, (root) =>
    renderList(root, p, selected, ctx));
  // The card's timeline reads the log, so only that contact's lines are part of its signature.
  const mine = state.cardTab === "history" && state.history ? state.history.filter((h) => h.contact === selected) : null;
  const plan = state.cardTab === "plan" ? planFor(p.operation.id, contact) : null;
  region($("card"), { op: p.operation.id, ai: state.settings?.ai, contact, zones: p.operation.zones, rel: p.contacts.map((c) => [c.ticket, c.state, c.conflictOf, c.blockedBy]), tab: state.cardTab, mine, plan, planUi: contact ? planUiKey(p.operation.id, contact.ticket) : "", busy, c: state.confirming }, (root) =>
    renderCard(root, p, contact, ctx, state.cardTab, state.cardTab === "history" ? state.history : null, plan));
  if (state.view === "table") {
    renderRadarOverlay(p, selected);
    region($("stage"), { op: p.operation.id, contacts: p.contacts.map((c) => [c.ticket, c.title, c.zone, c.group, c.state, c.attention, c.detail, c.blockedBy.map(b => [b.ticket, b.landed]), c.conflictOf]), zones: p.operation.zones, selected }, () =>
      radar.update(p, selected));
  } else if (state.view === "board") {
    region($("ops"), { op: p.operation, notes: p.notes, notesKey: notesKey(p.operation.id), counts: p.contacts.map((c) => [c.state, c.group, c.attention]), busy }, (root) => renderOps(root, p, ctx));
  } else {
    // Also reached by a page view while the connection is not live.
    renderPlanView(p, selected, ctx, busy);
  }
  syncRadar();
}

function renderProjectsPage() {
  ensureProjects();
  const guide = !onboardingHidden();
  if (guide && state.setup === undefined) loadSetup();
  const formOpen = $("projectsPage").querySelector(".proj-new");
  if (formOpen) return;
  region($("projectsPage"), { projects: state.projects, ops: state.operations.map((o) => [o.id, o.attention, o.project?.id]), guide, setup: state.setup }, (root) =>
    renderProjects(root, state.projects, state.operations, {
      api,
      toast,
      defaults: state.defaults,
      autoNew: state.newProject,
      onboarding: guide
        ? gettingStarted(state.setup, {
            toast,
            newOperation: () => {
              state.planView = "new";
              setView("plan");
            },
            openBoard: () => setView(state.operations.length ? "board" : "projects"),
            startTour,
            hide: render,
          })
        : null,
      openProject: (id) => {
        state.projects = null;
        state.newProject = false;
        openProject(id);
      },
      openOperation: (id) => openOperationPage(id),
      reload: () => loadProjects().then(render),
    }));
  state.newProject = false;
}

/** Plan view: map | op | new. */
function renderPlanView(p, selected, ctx, busy) {
  $("planTabs").hidden = false;
  $("planTabs").querySelector("[data-planview='new']").hidden = state.planView !== "new";
  markTabs($("planTabs"), (b) => b.dataset.planview === state.planView);
  $("planMap").hidden = state.planView !== "map";
  $("opPage").hidden = state.planView !== "op";
  $("newOp").hidden = state.planView !== "new";
  if (state.planView === "map") renderPlan(p, selected);
  else if (state.planView === "op") renderOpPage(p, ctx, busy);
  else renderNewOp();
}

function renderOpPage(p, ctx, busy) {
  const doc = state.opDoc;
  if (!doc) loadOpDoc().then(render);
  ensureProjects();
  const docKey = {
    projects: state.projects,
    op: p.operation.id,
    doc,
    ui: opUiKey(p.operation.id, p.operation.zones),
    auto: p.operation.auto,
    zones: p.operation.zones,
    contacts: p.contacts.map((c) => [c.ticket, c.title, c.description, c.zone, c.kind, c.state, c.problem, c.blockedBy, c.tracker?.url ?? null]),
    notes: p.notes,
    notesKey: notesKey(p.operation.id),
    busy,
  };
  region($("opPage"), docKey, (root) =>
    renderOperation(root, p, doc, {
      ...ctx,
      poll: () => poll(),
      reloadOp: async () => { await loadOpDoc(); render(); },
      saveOp: saveOpField,
      projects: state.projects ?? [],
      openProject,
      ended: opEnded,
      ticketUrl: lookupTicketUrl,
    }));
}

/** Fetch the project list once; rendering repeats when it arrives. */
let projectsLoading = false;
function ensureProjects() {
  if (state.projects !== null) return;
  state.projects = [];
  projectsLoading = true;
  loadProjects().then(() => {
    projectsLoading = false;
    render();
  });
}

async function loadArchive() {
  state.archive = await getJson("/api/archive");
  render();
}

async function openArchive(key) {
  state.archiveKey = key;
  if (key && !state.archiveReports.get(key)?.report) {
    state.archiveReports.set(key, { loading: true });
    render();
    state.archiveReports.set(key, await getJson(`/api/archive/report?key=${encodeURIComponent(key)}`));
  }
  render();
}

async function loadProjects() {
  state.setup = undefined;
  const data = await getJson("/api/projects");
  state.projects = Array.isArray(data) || data.error ? data : [];
}

async function loadProjectCfg() {
  if (!state.projectId) return;
  state.projectCfg = await getJson(`/api/project-config?project=${encodeURIComponent(state.projectId)}`);
}

function openProject(id) {
  state.projectId = id;
  state.projectCfg = null;
  loadProjectCfg().then(render);
  setView("project");
}

function renderProjectPage() {
  const ops = state.operations.filter((o) => o.project?.id === state.projectId);
  region($("projectPage"), { id: state.projectId, cfg: state.projectCfg, ops }, (root) =>
    renderProject(root, state.projectCfg, ops, {
      projectId: state.projectId,
      save: async (field, value, done) => {
        try {
          state.projectCfg = await postJson("/api/project-config", { project: state.projectId, field, value: String(value) });
          done?.(null);
          poll();
        } catch (error) {
          done?.(error);
        }
      },
      graph: async (op, done) => {
        try {
          state.projectCfg = await postJson("/api/project-graph", { project: state.projectId, op });
          toast(op === "install" ? "Graph server installed" : "Graph server restarted", "ok");
          done?.(null);
          render();
        } catch (error) {
          toast(errorText(error), "error");
          done?.(error);
        }
      },
      openOperation: (id) => openOperationPage(id),
      newOperation: async () => {
        await loadProjects();
        state.newOpProject = state.projectId;
        state.planView = "new";
        setView("plan");
      },
      remove: async () => {
        try {
          await postJson("/api/projects/remove", { project: state.projectId });
          toast("Project removed", "ok");
          state.projectId = null;
          setView("board");
        } catch (error) {
          toast(errorText(error), "error");
        }
      },
    }));
}

let setupLoading = false;
async function loadSetup() {
  if (setupLoading) return;
  setupLoading = true;
  state.setup = null;
  state.setup = await getJson("/api/setup");
  setupLoading = false;
  render();
}

let archiveLoading = false;
function renderArchivePage() {
  if (state.archive === null && !archiveLoading) {
    archiveLoading = true;
    loadArchive().finally(() => {
      archiveLoading = false;
    });
  }
  const entry = state.archiveKey ? state.archiveReports.get(state.archiveKey) ?? null : null;
  region($("archivePage"), { a: state.archive, key: state.archiveKey, entry }, (root) =>
    renderArchive(root, state.archive, state.archiveKey ? entry ?? { loading: true } : null, { open: openArchive }));
}

// Intel's module loads on its first visit, so the other views never fetch it.
let intel = null;
let intelImport = null;
function renderIntelPage() {
  markTabs($("intelTabs"), (b) => b.dataset.intelview === state.intelView);
  if (!intel) {
    intelImport ??= import("./intel.js").then(
      ({ createIntel }) => {
        intel = createIntel($("intelPage"), {
          api,
          sources: (archives) => {
            state.intelArchives = archives;
            renderHeader();
          },
          sourceGone: () => {
            setIntelArchive(null);
            render();
          },
          openBoard: openFromIntel,
          autoOf: (opId) => (state.projection?.operation.id === opId ? state.projection.operation.auto ?? null : null),
        });
        render();
      },
      (error) => toast(`Intel did not load: ${errorText(error)}`, "error"),
    );
    return;
  }
  let source = "";
  if (state.intelArchive) source = `archive:${state.intelArchive}`;
  else if (state.opId) source = `op:${state.opId}`;
  intel.show(state.intelView, source);
}

/** An Intel finding's link: its operation's Plan map, or the Board with the named contact selected. */
function openFromIntel({ plan, op, ticket }) {
  if (op && op !== state.opId) switchOp(op);
  if (plan) {
    storePlanView("map");
    setView("plan"); // polls
    return;
  }
  setView("board");
  if (ticket) select(ticket);
  showBoardTab("card");
  poll();
}

function renderNewOp() {
  ensureProjects();
  // The form focuses its first field, and a focused region never rebuilds: build it once, with the real projects.
  if (projectsLoading) return;
  region($("newOp"), { defaults: state.defaults, projects: state.projects, project: state.newOpProject ?? null }, (root) => {
    renderNewOperation(root, {
      defaults: state.defaults,
      projects: state.projects,
      project: state.newOpProject ?? state.operations.find((o) => o.id === state.opId)?.project?.id ?? null,
      api,
      toast,
      cancel: () => {
        state.newOpProject = null;
        storePlanView("map");
        render();
      },
      created: (id) => {
        state.newOpProject = null;
        state.projects = null;
        storePlanView("map");
        switchOp(id);
        poll();
      },
    });
  });
}

// Plan text per contact, keyed by the revision the projection reports: a new revision refetches.
const planCache = new Map();
const planLoading = new Set();
function planFor(opId, contact) {
  if (!contact?.plan) return null;
  const key = `${opId}/${contact.ticket}`;
  const hit = planCache.get(key);
  if (hit?.error || hit?.revision === contact.plan.revision) return hit;
  if (!planLoading.has(key)) {
    planLoading.add(key);
    getJson(`/api/plan?op=${encodeURIComponent(opId)}&contact=${encodeURIComponent(contact.ticket)}`).then((plan) => {
      planCache.set(key, plan);
      planLoading.delete(key);
      render();
    });
  }
  return null;
}

/** Mouse path to what needs you, over the radar; the keyboard path is WASD/HJKL. */
function renderRadarOverlay(p, selected) {
  const needs = p.contacts.filter((c) => c.attention);
  const done = allLanded(p);
  region($("radarNeeds"), { needs: needs.map((c) => [c.ticket, c.state]), selected, done, op: p.operation.id }, (root) => {
    root.replaceChildren();
    if (done) {
      root.append(doneBanner(p, { api, toast, ended: opEnded }));
      return;
    }
    if (!needs.length) return;
    root.append(el("span", "kicker", "Needs you"));
    for (const c of needs.slice(0, 6)) {
      const b = el("button", `rel${c.ticket === selected ? " on" : ""}`, c.ticket);
      b.type = "button";
      b.dataset.id = c.ticket;
      b.dataset.key = `need/${c.ticket}`;
      root.append(b);
    }
    if (needs.length > 6) root.append(el("span", "kicker", `+${needs.length - 6}`));
  });
}

function renderPlan(p, selected) {
  const map = $("planMap");
  const f = state.historyFilter;
  // Picking a contact in the plan focuses its chain; the rest of the plan fades.
  region(map, { op: p.operation, contacts: p.contacts, notes: p.notes, selected, focus: f.contact }, (root) => {
    renderMap(root, p, selected, f.contact, () => addContact(p));
    drawLinks(root, p, f.contact);
  });
  $("historyContact").hidden = !f.contact;
  $("historyContactName").textContent = f.contact ?? "";
  region($("historyList"), { op: p.operation.id, h: state.history?.length, f }, (root) => renderHistory(root, state.history ?? [], f));
}
async function loadOpDoc() {
  if (!state.opId) return;
  const id = state.opId;
  if (opDocPending?.id === id) return opDocPending.promise;
  const promise = (async () => {
    const doc = await getJson(`/api/operation?op=${encodeURIComponent(id)}`);
    if (state.opId === id) state.opDoc = doc;
  })();
  opDocPending = { id, promise };
  await promise;
  if (opDocPending?.promise === promise) opDocPending = null;
}

async function saveOpField(field, value, done) {
  if (!state.opId) return;
  try {
    await postJson("/api/operation-config", { op: state.opId, field, value: String(value) });
    await loadOpDoc();
    await poll();
    done?.(null);
  } catch (error) {
    if (done) done(error instanceof Error ? error : new Error(String(error)));
    else toast(errorText(error), "error");
  }
}

// Arrows depend on laid-out positions, so they follow the map's size, not the data.
new ResizeObserver(() => {
  if (state.view === "plan" && state.projection) drawLinks($("planMap"), state.projection, state.historyFilter.contact);
}).observe($("planMap"));

// ---- polling ----

function schedulePoll(delay = streamOpen() ? STREAM_FALLBACK_MS : POLL_INTERVAL_MS) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (document.visibilityState !== "visible") return;
  pollTimer = setTimeout(poll, delay);
}

function streamOpen() {
  return stream?.open === true;
}

function connectStream() {
  if (!token || stream || document.visibilityState !== "visible") return;
  stream = connectLive({
    api,
    changed: () => poll(),
    connected: () => schedulePoll(),
    disconnected: () => schedulePoll(POLL_INTERVAL_MS),
  });
}

async function poll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (!token) return render();
  if (document.visibilityState !== "visible") return;
  if (polling) {
    refreshPending = true;
    return pollDone;
  }
  polling = true;
  const finished = Promise.withResolvers();
  pollDone = finished.promise;
  try {
    const res = await api("/api/operations");
    if (document.visibilityState !== "visible") return;
    if (res.status === 401) {
      state.conn = "denied";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const newOps = await res.json();
    if (document.visibilityState !== "visible") return;
    if (state.operations && newOps.length !== state.operations.length) state.setup = undefined;
    state.operations = newOps;
    if (state.operations.length && !state.operations.some((o) => o.id === state.opId)) switchOp(state.operations[0].id);
    const pollOpId = state.opId;
    if (state.operations.length) {
      const pres = await api(`/api/projection?op=${encodeURIComponent(pollOpId)}`);
      if (document.visibilityState !== "visible") return;
      if (!pres.ok) throw new Error(`HTTP ${pres.status}`);
      const projection = await pres.json();
      if (state.opId !== pollOpId) return;
      if (state.projection && projection.contacts?.length !== state.projection.contacts?.length) state.setup = undefined;
      state.projection = projection;
      // Full history only while someone is looking at it: the plan map's panel or a card's History tab.
      if (historyShown()) {
        const hres = await api(`/api/history?op=${encodeURIComponent(pollOpId)}`);
        if (document.visibilityState !== "visible") return;
        if (hres.ok) {
           const h = await hres.json();
           if (state.opId !== pollOpId) return;
           state.history = h;
        }
      }
      // The graph-server pill is live health, not stored config, so refresh it with the rest.
      if (state.view === "project" && state.projectId) {
        const asked = state.projectId;
        const gres = await api(`/api/project-config?project=${encodeURIComponent(asked)}`);
        if (gres.ok) {
          const g = await gres.json();
          if (state.projectId === asked && state.view === "project") state.projectCfg = g;
        }
      }
    } else state.projection = null;
    state.conn = "live";
  } catch {
    state.conn = "lost";
  } finally {
    polling = false;
    finished.resolve();
    render();
    if (document.visibilityState === "visible") {
      schedulePoll(refreshPending ? 0 : undefined);
      refreshPending = false;
    }
  }
}

/** A poll that starts after any one in flight, so it sees what just changed. */
async function pollFresh() {
  if (polling) await pollDone;
  await poll();
}

// ---- events ----

$("toggle").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-view]");
  if (btn) setView(btn.dataset.view);
});

/** Tablist state: the selected tab is the only Tab stop (the first one when none is selected). */
function markTabs(list, isOn) {
  const tabs = [...list.querySelectorAll("[role=tab]")];
  for (const b of tabs) {
    b.setAttribute("aria-selected", String(isOn(b)));
    b.tabIndex = isOn(b) ? 0 : -1;
  }
  if (!tabs.some(isOn) && tabs.length) tabs[0].tabIndex = 0;
}
/** Left/Right and Home/End move to a neighbouring tab and open it. */
function tabKeys(list, open) {
  list.addEventListener("keydown", (e) => {
    const tabs = [...list.querySelectorAll("[role=tab]:not([hidden])")];
    const at = tabs.indexOf(document.activeElement);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (at === -1 || to === undefined) return;
    // Arrows would otherwise also move the board's selection.
    e.preventDefault();
    e.stopPropagation();
    const tab = tabs[(to + tabs.length) % tabs.length];
    open(tab);
    tab.focus();
  });
}

// Narrow screens show one Board panel at a time; the list keeps its scroll for the way back.
let listScroll = 0;
function showBoardTab(tab) {
  const narrow = $("boardTabs").getClientRects().length > 0;
  if (narrow && document.body.dataset.boardtab === "list") listScroll = scrollY;
  document.body.dataset.boardtab = tab;
  markTabs($("boardTabs"), (b) => b.dataset.boardtab === tab);
  if (narrow) scrollTo(0, tab === "list" ? listScroll : 0);
}
$("boardTabs").addEventListener("click", (event) => {
  const b = event.target.closest("[data-boardtab]");
  if (b) showBoardTab(b.dataset.boardtab);
});
tabKeys($("boardTabs"), (b) => showBoardTab(b.dataset.boardtab));

function setMore(open) {
  $("morePop").classList.toggle("open", open);
  $("moreButton").setAttribute("aria-expanded", String(open));
}
$("moreButton").addEventListener("click", () => setMore(!$("morePop").classList.contains("open")));
// A press outside closes it, and so does following one of its links or buttons; the Load stat only toggles its chip.
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#morePop, #moreButton")) setMore(false);
});
$("morePop").addEventListener("click", (event) => {
  if (event.target.closest("a, button")) setMore(false);
});
/** Plan → Map or Operation; the map's history panel needs a fetch the Operation page skipped. */
function showPlanView(view) {
  storePlanView(view);
  if (view === "op" && !state.opDoc) loadOpDoc().then(render);
  if (historyShown() && !state.history) poll();
  render();
}
$("planTabs").addEventListener("click", (event) => {
  const b = event.target.closest("[data-planview]");
  if (b) showPlanView(b.dataset.planview);
});
tabKeys($("planTabs"), (b) => showPlanView(b.dataset.planview));

function showIntelView(view) {
  storeIntelView(view);
  render();
}
$("intelTabs").addEventListener("click", (event) => {
  const b = event.target.closest("[data-intelview]");
  if (b) showIntelView(b.dataset.intelview);
});
tabKeys($("intelTabs"), (b) => showIntelView(b.dataset.intelview));

function setView(view) {
  if (view === "archive") state.archive = null; // fresh list each visit
  if (view === "intel" && state.view !== "intel") intel?.invalidate(); // fresh evidence each visit
  // Outside Intel the picker lists open operations only.
  if (view !== "intel") setIntelArchive(null);
  state.view = view;
  localStorage.setItem("holotable.view", view);
  syncRadar();
  if (view === "plan" && state.planView === "op") {
    if (!state.opDoc) loadOpDoc().then(render);
    else render();
  } else {
    render();
  }
  if (view === "plan") poll();
}

$("historyActors").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-actor]");
  if (!chip) return;
  state.historyFilter.actor = chip.dataset.actor;
  for (const b of $("historyActors").querySelectorAll("[data-actor]")) b.setAttribute("aria-pressed", String(b === chip));
  render();
});
$("historySearch").addEventListener("input", (event) => {
  state.historyFilter.text = event.target.value.trim();
  render();
});
$("historyClear").addEventListener("click", () => {
  state.historyFilter.contact = null;
  render();
});
$("historyOpen").addEventListener("click", () => {
  setView("board");
  showBoardTab("card");
});

$("projectCrumb").addEventListener("click", () => {
  const id = $("projectCrumb").dataset.project;
  if (id) openProject(id);
});
$("projectsCrumb").addEventListener("click", () => {
  state.projects = null;
  setView("projects");
});

/** Plan → Operation for `id` (default: the selected operation). */
function openOperationPage(id = state.opId) {
  if (id !== state.opId) switchOp(id);
  storePlanView("op");
  setView("plan"); // loads the operation doc and polls
}
$("autoInd").addEventListener("click", () => openOperationPage());
$("intWarn").addEventListener("click", () => openOperationPage());
$("intelLink").addEventListener("click", () => {
  // From an archive report, Intel opens on that operation's frozen evidence.
  if (state.view === "archive" && state.archiveKey) {
    setIntelArchive(state.archiveKey);
    storeIntelView("op");
  }
  setView("intel");
});

/** After close/abort the operation left the picker; poll() falls back to the first open one. */
function opEnded() {
  state.opDoc = null;
  state.archive = null;
  if (state.view === "plan") storePlanView("map");
  poll();
}

function addContact(p) {
  openAddContact(p, {
    api,
    toast,
    added: async (ticket) => {
      await poll();
      if (ticket) select(ticket);
    },
  });
}

/** Cmd/Ctrl+click opens the tracker issue. A missing sample URL is resolved; delivery PRs stay on the card. */
function openTicketAtTracker(ticket) {
  const projection = state.projection;
  const contact = projection?.contacts.find((item) => item.ticket === ticket);
  if (!contact || !projection) return;
  void openTicket(contact, projection.operation.tracker, (text) => toast(text, "error"), lookupTicketUrl);
}

const resolvedTicketUrls = new Map();
async function lookupTicketUrl(ticket) {
  const key = `${state.opId}/${ticket}`;
  if (resolvedTicketUrls.has(key)) return resolvedTicketUrls.get(key);
  const res = await api(`/api/tracker/issue?op=${encodeURIComponent(state.opId)}&ticket=${encodeURIComponent(ticket)}`);
  const data = await res.json().catch(() => null);
  if (!res.ok) return null;
  const url = typeof data?.url === "string" ? data.url : null;
  if (url) resolvedTicketUrls.set(key, url);
  return url;
}
// Capture phase, so the modified click opens the link instead of selecting or pressing anything.
document.addEventListener(
  "click",
  (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.target.closest("button[data-action]")) return;
    const host = event.target.closest("[data-id], [data-ticket], [data-key^='node/']");
    const ticket = host?.dataset.id ?? host?.dataset.ticket ?? host?.dataset.key?.slice("node/".length);
    if (!ticket || !state.projection?.contacts.some((c) => c.ticket === ticket)) return;
    event.preventDefault();
    event.stopPropagation();
    openTicketAtTracker(ticket);
  },
  true,
);

$("needs").addEventListener("click", () => {
  const first = state.projection?.contacts.find((c) => c.attention);
  if (first) {
    select(first.ticket);
    setView("board");
    showBoardTab("card");
  }
});

document.addEventListener("click", (event) => {
  const action = event.target.closest("button[data-action]");
  if (action) {
    confirmOrRun(action.dataset.ticket, action.dataset.action);
    return;
  }
  const pick = event.target.closest("[data-id]");
  if (!pick) return;
  // Selection rebuilds the map before the browser can dispatch dblclick to its old target.
  const openCard = event.detail === 2 && Boolean(pick.closest("#planMap"));
  const fromList = Boolean(pick.closest("#list"));
  select(pick.dataset.id);
  if (openCard) setView("board");
  if (openCard || fromList) showBoardTab("card");
});

const VIEW_KEYS = { t: "table", 1: "table", b: "board", 2: "board", p: "plan", 3: "plan", i: "intel", 4: "intel" };

/** Points the arrow keys move between, in the current view's own layout. */
function navPoints() {
  if (state.view === "table") return radar.positions();
  if (state.view === "plan")
    return [...document.querySelectorAll("#planMap .node")].map((n) => {
      const r = n.getBoundingClientRect();
      return { ticket: n.dataset.ticket, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  return null;
}

function move(dir) {
  const p = state.projection;
  if (!p) return;
  const points = navPoints();
  const current = selectedTicket();
  if (points) {
    if (!points.length) return;
    const from = points.find((pt) => pt.ticket === current);
    const next = from ? nearestInDirection(points, from, dir) : points[0].ticket;
    if (next) select(next, true);
  } else {
    // Board: the list is one column, so up/down walk it and left/right do nothing.
    if (dir !== "up" && dir !== "down") return;
    const order = orderedTickets(p);
    if (!order.length) return;
    const at = order.indexOf(current);
    select(order[(at + (dir === "down" ? 1 : -1) + order.length) % order.length], true);
  }
  document.querySelector(`[data-key="sel/${CSS.escape(selectedTicket())}"], [data-key="node/${CSS.escape(selectedTicket())}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
let lastInteractionTime = Date.now();
for (const ev of ["pointerdown", "keydown"]) {
  document.addEventListener(ev, () => { lastInteractionTime = Date.now(); }, { capture: true });
}

document.addEventListener("keydown", (event) => {
  if (settingsDrawer.isOpen()) return; // the drawer traps its own keys
  if (event.target.closest?.("[data-cmp], input, select, textarea") || event.metaKey || event.ctrlKey || event.altKey) return;
  const help = $("help");
  if (event.key === "?") {
    if (help.open) help.close();
    else help.showModal();
    return;
  }
  // The open dialog closes itself on Escape; nothing behind it reacts.
  if (help.open) return;
  if (event.key === "Escape") {
    $("toasts").replaceChildren();
    state.confirming = null;
    setMore(false);
    // In the plan, Esc undoes a focused chain just as clicking the focused node again does.
    state.historyFilter.contact = null;
    document.activeElement?.blur?.();
    render();
    return;
  }
  if (event.key === ",") {
    event.preventDefault();
    settingsDrawer.open();
    return;
  }
  // On a focused button Enter and Space mean "press it"; every other key still drives the board.
  const onControl = event.target.closest?.("button");
  if (VIEW_KEYS[event.key]) return setView(VIEW_KEYS[event.key]);
  // Pages have no contacts to move between or act on; arrows scroll them.
  if (PAGES[state.view]) return;
  if (event.key.toUpperCase() === "P" && event.shiftKey && state.view === "plan") {
    event.preventDefault();
    showPlanView(state.planView === "map" ? "op" : "map");
    return;
  }
  const dir = KEY_DIR[event.key];
  if (dir) {
    event.preventDefault();
    move(dir);
    return;
  }
  if (event.key === "Enter" && !onControl) {
    // Enter moves focus to the card's main action; a second Enter presses it. Nothing fires on one key.
    const primary = $("card").querySelector(".actions .btn.primary:not(:disabled)") ?? $("card").querySelector(".actions .btn:not(:disabled)");
    if (primary) {
      event.preventDefault();
      if (state.view === "plan") setView("board");
      ($("card").querySelector(".actions .btn.primary:not(:disabled)") ?? $("card").querySelector(".actions .btn:not(:disabled)"))?.focus();
    }
    return;
  }
  if ((event.key === "[" || event.key === "]") && !onControl) {
    const contact = state.projection?.contacts.find((c) => c.ticket === selectedTicket());
    const ids = cardTabs(contact).map(([id]) => id);
    const at = ids.indexOf(state.cardTab);
    setCardTab(ids[(at + (event.key === "]" ? 1 : -1) + ids.length) % ids.length]);
  }
});

function setCardTab(tab) {
  state.cardTab = tab;
  localStorage.setItem("holotable.cardTab", tab);
  render();
  if (tab === "history" && !state.history) poll();
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-cardtab]");
  if (tab) setCardTab(tab.dataset.cardtab);
});
$("settingsButton").addEventListener("click", () => settingsDrawer.open());
$("help").addEventListener("click", (event) => {
  if (event.target === $("help") || event.target.closest("[data-close]")) $("help").close();
});

document.addEventListener("visibilitychange", () => {
  syncRadar();
  if (document.visibilityState === "visible") {
    connectStream();
    poll();
  } else {
    stream?.close();
    stream = null;
    clearTimeout(pollTimer);
    pollTimer = null;
  }
});
render();
connectStream();
if (document.visibilityState === "visible") poll();
