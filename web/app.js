// Holotable shell: token, polling, connection state, selection, actions, toasts, keyboard.
// Regions re-render only when their data changed, and never under an open <select>,
// so a 3 s poll does not steal focus, close dropdowns or flicker.
import { renderOps } from "./board.js";
import { cardTabs, clearCardDecision, clearDecideModel, clearLaunchModel, getCardDecision, getDecideModel, getLaunchModel, planUiKey, renderCard } from "./card.js";
import { orderedTickets, renderList } from "./list.js";
import { drawLinks, renderHistory, renderMap } from "./plan.js";
import { createRadar } from "./radar.js";
import { createSettingsDrawer } from "./settings.js";
import { CONFIRM, el, fmtMs, KEY_DIR, nearestInDirection } from "./ui.js";
import { dropdown, popoverOpenWithin } from "./components.js";
import { renderNewOperation } from "./newop.js";
import { opUiKey, renderOperation } from "./operation.js";
import { renderArchive } from "./archive.js";
import { renderProject } from "./project.js";
import { renderProjects } from "./projects.js";
import { openDecide } from "./decide.js";
import { gettingStarted, onboardingHidden, showOnboarding, startTour, tourPending } from "./onboarding.js";
import { openAddContact } from "./addcontact.js";
import { allLanded, doneBanner } from "./endop.js";
import { ensureNotes, notesKey } from "./notes.js";
import { icon } from "./icons.js";
import { installTooltips } from "./tooltip.js";
import { installLoadTip } from "./usage.js";

installTooltips();


const $ = (id) => document.getElementById(id);


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
  view: ["board", "plan"].includes(localStorage.getItem("holotable.view")) ? localStorage.getItem("holotable.view") : "table",
  history: null,
  cardTab: ["details", "history"].includes(localStorage.getItem("holotable.cardTab")) ? localStorage.getItem("holotable.cardTab") : "overview",
  historyFilter: { contact: null, actor: "all", text: "" },
  selected: JSON.parse(localStorage.getItem("holotable.selected") || "{}"),
  busy: new Set(),
  confirming: null,
  conn: "connecting",
  planView: ["map", "op", "new"].includes(localStorage.getItem("holotable.planView")) ? localStorage.getItem("holotable.planView") : "map",
  archive: null, // GET /api/archive rows, or {error}
  projects: null, // GET /api/projects rows
  setup: undefined, // GET /api/setup: undefined = not asked, null = loading, {error} on failure
  projectId: null,
  projectCfg: null, // GET /api/project-config, or {error}
  archiveKey: null, // open report
  archiveReports: new Map(),
  opDoc: null,
  defaults: { tracker: "none", fleet: "omp-mission", frontend: "none", delivery: "none" },
};
const POLL_INTERVAL_MS = 3000;
let polling = false;
let pollTimer = null;
let confirmTimer = null;

const api = (path, options = {}) => {
  const headers = new Headers(options.headers || {});
  headers.set("X-Holotable-Token", token);
  if (options.body) headers.set("Content-Type", "application/json");
  return fetch(path, { ...options, headers, credentials: "same-origin", cache: "no-store" });
};
installLoadTip($("load").closest(".stat"), {
  api,
  opId: () => state.opId,
  sessions: () => ({ op: state.projection?.stats.omp.current ?? 0, all: state.projection?.header.open ?? 0 }),
  ops: () => state.operations.length,
});

// ---- toasts ----

function toast(text, kind = "info") {
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
  // Errors stay until dismissed: the operator has to read why something did not happen.
  if (kind !== "error") setTimeout(() => box.remove(), 4000);
  while ($("toasts").childElementCount > 4) $("toasts").firstElementChild.remove();
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

// Table view centre: one radar instance for the session; update() replaces its data, never its canvas.
const radar = createRadar($("stage"), {
  onSelect: (ticket, event) => (event && (event.metaKey || event.ctrlKey) ? openProvider(ticket) : select(ticket)),
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
        state.planView = "new";
        localStorage.setItem("holotable.planView", "new");
        setView("plan");
      },
    },
    { label: "Archive", icon: "archive", className: "dd-link", onPick: () => setView("archive") },
  ],
  onChange: (id) => {
    state.opId = id;
    localStorage.setItem("holotable.op", state.opId);
    state.opDoc = null;
    state.projection = null;
    state.history = null;
    state.historyFilter.contact = null;
    if (state.planView === "new") {
      state.planView = "map";
      localStorage.setItem("holotable.planView", "map");
    }
    // Archive and project pages are not about one operation; choosing one means "go look at it".
    if (state.view === "archive" || state.view === "project" || state.view === "projects") setView("board");
    poll();
  },
});
$("op").append(opPick.root);

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("holotable.theme", theme);
}
let tourOffered = false; // the first-visit tour starts at most once per page load
const settingsDrawer = createSettingsDrawer({
  api,
  applyTheme,
  toast,
  settingsChanged: (settings) => { state.settings = settings; render(); },
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
  try {
    const res = await api("/api/settings");
    if (res.ok) {
      const data = await res.json();
      applyTheme(data.settings.theme);
      state.settings = data.settings;
      if (data.settings.defaults) state.defaults = { ...state.defaults, ...data.settings.defaults, ai: data.settings.ai };
    }
  } catch {
  }
}
loadTheme();
// ---- actions ----

const PAST = {
  launch: "launched", land: "landed", approve: "approved", continue: "continued", review: "sent to review",
  dispatch: "dispatched", done: "marked done", reap: "terminal closed", focus: "focused", mode: "mode changed",
  "plan-save": "plan saved", "plan-refine": "refinement sent to the mission",
  relaunch: "reopened", redecide: "decision changed", "decide-agent": "agent asked to decide",
};

/** Runs one board action; resolves `{ok, error}` so callers like the plan editor can react. */
async function runAction(ticket, action, args = {}, opId = state.opId) {
  const key = `${ticket}/${action}`;
  if (state.busy.has(key)) return { ok: false, error: "busy: already running" };
  state.busy.add(key);
  state.busy.add(`${ticket}/*`);
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
    state.busy.delete(key);
    state.busy.delete(`${ticket}/*`);
    await poll();
  }
  return outcome;
}

function confirmOrRun(ticket, action) {
  const opId = state.opId;
  const key = `${ticket}/${action}`;
  // Recording a decision needs the choice (and maybe why), so it opens a dialog first.
  const contact = state.projection?.contacts.find((c) => c.ticket === ticket);
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
function opsStatsSig(s) {
  if (!s) return null;
  return [
    s.omp?.current,
    s.omp?.peak,
    s.queueWaitAvgMs !== undefined ? fmtMs(s.queueWaitAvgMs) : null,
    s.gateWaitMs !== undefined ? fmtMs(s.gateWaitMs) : null,
    s.landAttempts,
    s.conflictRate !== undefined ? Math.round(s.conflictRate * 100) : null,
    s.socketDownMs !== undefined ? fmtMs(s.socketDownMs) : null,
    s.tokens ? `${s.tokens.input},${s.tokens.output},${s.tokens.cacheRead},${s.tokens.cacheWrite}` : null,
    s.costUsd !== undefined && s.costUsd !== null ? s.costUsd.toFixed(2) : null,
    s.phaseMs ? Object.entries(s.phaseMs).map(([k, v]) => `${k}:${fmtMs(v)}`).sort().join(";") : null,
  ];
}

let lastHeaderSig = "";
function renderHeader() {
  const p = state.projection;
  const current = state.operations.find((o) => o.id === state.opId);
  const shown =
    state.view === "project" && state.projectId
      ? { id: state.projectId, name: state.projectCfg?.fields?.name ?? state.projectId }
      : state.view === "projects"
        ? null
        : current?.project;
  const needs = p ? p.contacts.filter((c) => c.attention).length : 0;
  const sig = JSON.stringify([
    state.operations.map((o) => [o.id, o.name, o.attention, o.project?.id, o.project?.name]),
    state.opId,
    state.view,
    shown,
    p ? [p.operation.base, p.header.open, p.header.cap, p.notes?.done, p.notes?.total, needs, p.operation.auto] : null,
    state.conn,
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
  const keys = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : groups.get(a).name.localeCompare(groups.get(b).name)));
  const grouped = keys.length > 1 || keys[0] !== "";
  const options = [];
  for (const key of keys) {
    const g = groups.get(key);
    if (grouped) options.push({ value: `group:${key}`, label: g.name, group: true, disabled: true });
    for (const o of g.ops)
      options.push({ value: o.id, label: `${o.name}${o.attention ? ` · ${o.attention} need you` : ""}`, indent: grouped });
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
  opPick.setOptions(options, state.opId, state.operations.length ? "Select operation" : "No operations");
  opPick.setDisabled(!state.operations.length);
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
  $("needsText").textContent = `${needs} need${needs === 1 ? "s" : ""} you`;
  $("conn").className = `conn c-${state.conn}`;
  $("connText").textContent = { live: "live", connecting: "connecting", lost: "reconnecting", denied: "token rejected" }[state.conn];
  const auto = p?.operation?.auto;
  $("autoInd").hidden = !auto?.enabled;
  $("autoText").textContent = auto?.enabled ? (auto.launch || auto.land ? "Auto" : "Auto (manual land)") : "";
}
function showBlank(message, detail) {
  document.body.dataset.view = "blank";
  const blank = $("blank");
  blank.replaceChildren(el("h2", "", message), el("p", "", detail));
  blank.hidden = false;
  syncRadar();
}

function render() {
  syncRadar();
  renderHeader();
  if (!token) return showBlank("No access token", "Open the full URL that /holotable printed in OMP (it ends in #<token>).");
  if (state.conn === "denied") return showBlank("Token rejected", "The board was restarted and has a new URL. Run /holotable in OMP and open the URL it prints.");
  if (state.view === "projects" && state.conn === "live") {
    $("blank").hidden = true;
    document.body.dataset.view = "projects";
    delete document.body.dataset.planview;
    if (state.projects === null) {
      state.projects = [];
      loadProjects().then(render);
    }
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
    syncRadar();
    return;
  }
  if (state.view === "project" && state.conn === "live" && state.projectId) {
    $("blank").hidden = true;
    document.body.dataset.view = "project";
    delete document.body.dataset.planview;
    renderProjectPage();
    syncRadar();
    return;
  }
  // The archive needs no open operation: it is about the ones that ended.
  if (state.view === "archive" && state.conn === "live") {
    $("blank").hidden = true;
    document.body.dataset.view = "archive";
    delete document.body.dataset.planview;
    renderArchivePage();
    syncRadar();
    return;
  }
  if (!state.operations.length && state.conn === "live") {
    if (state.view === "plan" && state.planView === "new") {
      $("blank").hidden = true;
      document.body.dataset.view = "plan";
      document.body.dataset.planview = "new";
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
  $("blank").hidden = true;
  document.body.dataset.view = state.view;
  if (state.view === "plan") document.body.dataset.planview = state.planView;
  else delete document.body.dataset.planview;
  // Default to what needs the operator first, not merely the first live contact.
  let selected = selectedTicket();
  let contact = p.contacts.find((c) => c.ticket === selected) ?? null;
  if (!contact) {
    state.selected[state.opId] = orderedTickets(p)[0] ?? p.selection;
    selected = selectedTicket();
    contact = p.contacts.find((c) => c.ticket === selected) ?? null;
  } else if (contact.state === "landed" && Date.now() - lastInteractionTime > 10000 && !document.querySelector(".modal-scrim:not([hidden]), .plan-edit, .settings-scrim:not([hidden]), [data-popover]")) {
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
    busy: state.busy,
    confirming: state.confirming,
    run: runAction,
    openOperationPage: () => openOperationPage(),
    rerender: () => render(),
    addContact: () => addContact(p),
    endCtx: { api, toast, ended: opEnded },
    api,
    toast,
    notesChanged: () => poll(),
    refreshPlan: async () => {
      if (contact) planCache.delete(`${p.operation.id}/${contact.ticket}`);
      await poll();
      render();
    },
  };
  const busy = [...state.busy];
  if (state.view === "board" || (state.view === "plan" && state.planView === "op")) ensureNotes(p.operation.id, p.notes, api, render);

  region($("list"), { op: p.operation.id, contacts: p.contacts, zones: p.operation.zones, selected, busy, c: state.confirming }, (root) =>
    renderList(root, p, selected, ctx));
  // The card's timeline reads the log, so only that contact's lines are part of its signature.
  const mine = state.cardTab === "history" && state.history ? state.history.filter((h) => h.contact === selected) : null;
  const plan = state.cardTab === "plan" ? planFor(p.operation.id, contact) : null;
  region($("card"), { op: p.operation.id, ai: state.settings?.ai, contact, zones: p.operation.zones, rel: p.contacts.map((c) => [c.ticket, c.state, c.conflictOf, c.blockedBy]), tab: state.cardTab, mine, plan, planUi: contact ? planUiKey(p.operation.id, contact.ticket) : "", busy, c: state.confirming }, (root) =>
    renderCard(root, p, contact, ctx, state.cardTab, state.cardTab === "history" ? state.history : null, plan));
  if (state.view === "table") renderRadarOverlay(p, selected);
  if (state.view === "table")
    region($("stage"), { op: p.operation.id, contacts: p.contacts.map((c) => [c.ticket, c.title, c.zone, c.group, c.state, c.attention, c.detail, c.blockedBy.map(b => [b.ticket, b.landed]), c.conflictOf]), zones: p.operation.zones, selected }, () =>
      radar.update(p, selected));
  else if (state.view === "board")
    region($("ops"), { op: p.operation, notes: p.notes, notesKey: notesKey(p.operation.id), stats: opsStatsSig(p.stats), counts: p.contacts.map((c) => [c.state, c.group, c.attention]), busy }, (root) => renderOps(root, p, ctx));
  else {
    // Plan view: map | op | new
    const tabs = $("planTabs");
    tabs.hidden = false;
    document.querySelectorAll("#planTabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.planview === state.planView)));
    $("planMap").hidden = state.planView !== "map";
    $("opPage").hidden = state.planView !== "op";
    $("newOp").hidden = state.planView !== "new";
    if (state.planView === "map") renderPlan(p, selected);
    else if (state.planView === "op") {
      const doc = state.opDoc;
      if (state.projects === null) {
        state.projects = [];
        loadProjects().then(render);
      }
      const docKey = {
        projects: state.projects,
        op: p.operation.id,
        doc,
        ui: opUiKey(p.operation.id),
        auto: p.operation.auto,
        zones: p.operation.zones,
        contacts: p.contacts.map((c) => [c.ticket, c.title, c.description, c.zone, c.kind, c.state, c.blockedBy]),
        notes: p.notes,
        notesKey: notesKey(p.operation.id),
        busy: [...ctx.busy],
      };
      region($("opPage"), docKey, (root) => {
        const c = {
          ...ctx,
          api,
          toast,
          poll: () => poll(),
          reloadOp: async () => { await loadOpDoc(); render(); },
          run: runAction,
          rerender: () => render(),
          saveOp: saveOpField,
          addContact: () => addContact(p),
          projects: state.projects ?? [],
          openProject,
          ended: opEnded,
        };
        renderOperation(root, p, doc, c);
      });
    } else renderNewOp();
  }
  syncRadar();
}
async function loadArchive() {
  try {
    const res = await api("/api/archive");
    const data = await res.json().catch(() => null);
    state.archive = res.ok && Array.isArray(data) ? data : { error: data?.error ?? `HTTP ${res.status}` };
  } catch (error) {
    state.archive = { error: error instanceof Error ? error.message : String(error) };
  }
  render();
}

async function openArchive(key) {
  state.archiveKey = key;
  if (key && !state.archiveReports.get(key)?.report) {
    state.archiveReports.set(key, { loading: true });
    render();
    try {
      const res = await api(`/api/archive/report?key=${encodeURIComponent(key)}`);
      const data = await res.json().catch(() => null);
      state.archiveReports.set(key, res.ok && data ? data : { error: data?.error ?? `HTTP ${res.status}` });
    } catch (error) {
      state.archiveReports.set(key, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  render();
}

async function loadProjects() {
  state.setup = undefined;
  try {
    const res = await api("/api/projects");
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    state.projects = Array.isArray(data) ? data : [];
  } catch (e) {
    state.projects = { error: e instanceof Error ? e.message : String(e) };
  }
}

async function loadProjectCfg() {
  if (!state.projectId) return;
  try {
    const res = await api(`/api/project-config?project=${encodeURIComponent(state.projectId)}`);
    const data = await res.json().catch(() => null);
    state.projectCfg = res.ok && data ? data : { error: data?.error ?? `HTTP ${res.status}` };
  } catch (error) {
    state.projectCfg = { error: error instanceof Error ? error.message : String(error) };
  }
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
          const res = await api("/api/project-config", { method: "POST", body: JSON.stringify({ project: state.projectId, field, value: String(value) }) });
          const data = await res.json().catch(() => null);
          if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
          state.projectCfg = data;
          toast("Saved", "ok");
          done?.(null);
          poll();
        } catch (error) {
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
          const res = await api("/api/projects/remove", { method: "POST", body: JSON.stringify({ project: state.projectId }) });
          const data = await res.json().catch(() => null);
          if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
          toast("Project removed", "ok");
          state.projectId = null;
          setView("board");
        } catch (error) {
          toast(error instanceof Error ? error.message : String(error), "error");
        }
      },
    }));
}

let setupLoading = false;
async function loadSetup() {
  if (setupLoading) return;
  setupLoading = true;
  state.setup = null;
  try {
    const res = await api("/api/setup");
    const data = await res.json().catch(() => null);
    state.setup = res.ok && data ? data : { error: data?.error ?? `HTTP ${res.status}` };
  } catch (error) {
    state.setup = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    setupLoading = false;
    render();
  }
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

function renderNewOp() {
  if (state.projects === null) {
    state.projects = [];
    loadProjects().then(render);
  }
  region($("newOp"), { defaults: state.defaults, projects: state.projects, project: state.newOpProject ?? null }, (root) => {
    renderNewOperation(root, {
      defaults: state.defaults,
      projects: state.projects,
      project: state.newOpProject ?? state.operations.find((o) => o.id === state.opId)?.project?.id ?? null,
      api,
      toast,
      cancel: () => {
        state.newOpProject = null;
        state.planView = "map";
        localStorage.setItem("holotable.planView", "map");
        render();
      },
      created: (id) => {
        state.newOpProject = null;
        state.projects = null;
        state.planView = "map";
        localStorage.setItem("holotable.planView", "map");
        state.opId = id;
        localStorage.setItem("holotable.op", id);
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
    api(`/api/plan?op=${encodeURIComponent(opId)}&contact=${encodeURIComponent(contact.ticket)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        planCache.set(key, res.ok && data ? data : { error: data?.error ?? `HTTP ${res.status}` });
      })
      .catch((error) => planCache.set(key, { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
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
  try {
    const res = await api(`/api/operation?op=${encodeURIComponent(state.opId)}`);
    if (res.ok) state.opDoc = await res.json();
    else state.opDoc = { error: `HTTP ${res.status}` };
  } catch (e) {
    state.opDoc = { error: e instanceof Error ? e.message : String(e) };
  }
}

async function saveOpField(field, value, done) {
  if (!state.opId) return;
  try {
    const res = await api("/api/operation-config", {
      method: "POST",
      body: JSON.stringify({ op: state.opId, field, value: String(value) }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    await loadOpDoc();
    await poll();
    done?.(null);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (done) done(err);
    else toast(err.message, "error");
  }
}

// Arrows depend on laid-out positions, so they follow the map's size, not the data.
new ResizeObserver(() => {
  if (state.view === "plan" && state.projection) drawLinks($("planMap"), state.projection, state.historyFilter.contact);
}).observe($("planMap"));

// ---- polling ----

function schedulePoll(delay = POLL_INTERVAL_MS) {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (document.visibilityState !== "visible") return;
  pollTimer = setTimeout(poll, delay);
}

async function poll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (!token) return render();
  if (document.visibilityState !== "visible") return;
  if (polling) return;
  polling = true;
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
    if (state.operations.length && !state.operations.some((o) => o.id === state.opId)) {
      state.opId = state.operations[0].id;
      localStorage.setItem("holotable.op", state.opId);
      state.opDoc = null;
      state.projection = null;
      state.history = null;
    }
    const pollOpId = state.opId;
    if (state.operations.length) {
      const pres = await api(`/api/projection?op=${encodeURIComponent(pollOpId)}`);
      if (document.visibilityState !== "visible") return;
      if (!pres.ok) throw new Error(`HTTP ${pres.status}`);
      const projection = await pres.json();
      if (state.opId !== pollOpId) return;
      if (state.projection && projection.contacts?.length !== state.projection.contacts?.length) state.setup = undefined;
      state.projection = projection;
      // Full history only while someone is looking at it.
      if (state.view === "plan" || state.cardTab === "history") {
        const hres = await api(`/api/history?op=${encodeURIComponent(pollOpId)}`);
        if (document.visibilityState !== "visible") return;
        if (hres.ok) {
           const h = await hres.json();
           if (state.opId !== pollOpId) return;
           state.history = h;
        }
      }
    } else state.projection = null;
    state.conn = "live";
  } catch {
    state.conn = "lost";
  } finally {
    polling = false;
    render();
    if (document.visibilityState === "visible") {
      schedulePoll(POLL_INTERVAL_MS);
    }
  }
}

// ---- events ----

$("toggle").addEventListener("click", (event) => {
  const btn = event.target.closest("[data-view]");
  if (btn) setView(btn.dataset.view);
});
$("planTabs").addEventListener("click", (event) => {
  const b = event.target.closest("[data-planview]");
  if (!b) return;
  state.planView = b.dataset.planview;
  localStorage.setItem("holotable.planView", state.planView);
  if (state.planView === "op" && !state.opDoc) loadOpDoc().then(render);
  render();
});

function setView(view) {
  if (view === "archive") state.archive = null; // fresh list each visit
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
$("historyOpen").addEventListener("click", () => setView("board"));

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
  if (id !== state.opId) {
    state.opId = id;
    localStorage.setItem("holotable.op", id);
    state.opDoc = null;
    state.projection = null;
    state.history = null;
  }
  state.planView = "op";
  localStorage.setItem("holotable.planView", "op");
  setView("plan"); // loads the operation doc and polls
}
$("autoInd").addEventListener("click", () => {
  openOperationPage();
});

/** After close/abort the operation left the picker; poll() falls back to the first open one. */
function opEnded() {
  state.opDoc = null;
  state.archive = null;
  if (state.view === "plan") {
    state.planView = "map";
    localStorage.setItem("holotable.planView", "map");
  }
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

/** Cmd/Ctrl+click on a ticket opens it at its provider: the tracker issue, else its pull request. */
function openProvider(ticket) {
  const c = state.projection?.contacts.find((x) => x.ticket === ticket);
  const url = c?.tracker?.url ?? c?.delivery?.url ?? null;
  if (url && /^https?:\/\//.test(url)) window.open(url, "_blank", "noopener");
  else if (state.projection?.operation.tracker === "none") toast(`${ticket}: this operation has no tracker, and no PR yet.`, "error");
  else toast(`${ticket} has no tracker or PR link yet (it appears once the tracker has been checked).`, "error");
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
    openProvider(ticket);
  },
  true,
);

$("needs").addEventListener("click", () => {
  const first = state.projection?.contacts.find((c) => c.attention);
  if (first) {
    select(first.ticket);
    setView("board");
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
  select(pick.dataset.id);
  if (openCard) setView("board");
});

const VIEW_KEYS = { t: "table", 1: "table", b: "board", 2: "board", p: "plan", 3: "plan" };

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
  if (event.key === "Escape") {
    $("toasts").replaceChildren();
    state.confirming = null;
    // In the plan, Esc undoes a focused chain just as clicking the focused node again does.
    state.historyFilter.contact = null;
    document.activeElement?.blur?.();
    render();
    return;
  }
  if (help.open) return;
  if (event.key === ",") {
    event.preventDefault();
    settingsDrawer.open();
    return;
  }
  // On a focused button Enter and Space mean "press it"; every other key still drives the board.
  const onControl = event.target.closest?.("button");
  if (VIEW_KEYS[event.key]) return setView(VIEW_KEYS[event.key]);
  if (event.key.toUpperCase() === "P" && event.shiftKey && state.view === "plan") {
    event.preventDefault();
    const next = state.planView === "map" ? "op" : state.planView === "op" ? "map" : "map";
    state.planView = next;
    localStorage.setItem("holotable.planView", next);
    if (next === "op" && !state.opDoc) loadOpDoc().then(render);
    else render();
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
    poll();
  } else {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
});
render();
if (document.visibilityState === "visible") poll();
