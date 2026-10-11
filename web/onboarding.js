// First-run help. "Getting started" checks the machine (GET /api/setup: omp, omp-mission, the
// frontends and trackers in use) and walks the first project → operation → contact → launch,
// ticking steps off from real counts. The tour points at the header controls one at a time.
import { el } from "./components.js";
import { icon } from "./icons.js";

const DISMISSED = "holotable.onboarding.hidden";
const TOURED = "holotable.onboarding.toured";

export const onboardingHidden = () => localStorage.getItem(DISMISSED) === "1";
export function showOnboarding() {
  localStorage.removeItem(DISMISSED);
}
/** True once, for a browser that has never seen the tour. */
export function tourPending() {
  return localStorage.getItem(TOURED) !== "1";
}

function stepRow(done, title, detail, action) {
  const row = el("div", `ob-step${done ? " done" : ""}`);
  const mark = el("span", "ob-mark");
  if (done) mark.append(icon("check", { size: 12 }));
  const text = el("div", "ob-text");
  text.append(el("div", "ob-title", title), el("div", "set-note", detail));
  row.append(mark, text);
  if (action && !done) row.append(action);
  return row;
}

function button(label, iconName, onClick, primary = false) {
  const b = el("button", `btn small${primary ? " primary" : ""}`);
  b.type = "button";
  if (iconName) b.append(icon(iconName, { size: 12 }));
  b.append(document.createTextNode(label));
  b.addEventListener("click", onClick);
  return b;
}

/**
 * The Getting started card. `setup`: GET /api/setup (or null while loading, or {error}).
 * ctx: { newOperation(), openBoard(), startTour(), hide() }
 */
export function gettingStarted(setup, ctx) {
  const box = el("section", "ob-card");
  const head = el("div", "ob-head");
  head.append(icon("rocket", { size: 16 }), el("h2", "", "Getting started"));
  const hide = el("button", "linkish", "Hide");
  hide.type = "button";
  hide.title = "Settings → Help brings it back";
  hide.addEventListener("click", () => {
    localStorage.setItem(DISMISSED, "1");
    ctx.hide();
  });
  head.append(hide);
  box.append(
    head,
    el(
      "p",
      "set-note",
      "Holotable runs campaigns of omp missions. A project is a repo; an operation is one campaign in it; contacts are its tickets. The board launches each contact as an omp mission in its own worktree, watches it, and asks you when it needs a decision.",
    ),
  );

  // Machine checks.
  const checks = el("div", "ob-checks");
  if (setup === null) checks.append(el("div", "empty-line", "Checking this machine…"));
  else if (setup.error) checks.append(el("div", "set-err", `Setup checks unavailable: ${setup.error}`));
  else
    for (const c of setup.checks) {
      const row = el("div", `ob-check ${c.ok ? "ok" : "bad"}`);
      row.append(icon(c.ok ? "check" : "triangle-alert", { size: 13 }), el("span", "ob-check-label", c.label), el("span", "set-note", c.detail));
      if (!c.ok && c.fix) {
        const fix = el("button", "ob-fix", c.fix);
        fix.type = "button";
        fix.title = "Click to copy";
        fix.addEventListener("click", () => {
          navigator.clipboard?.writeText(c.fix).then(
            () => ctx.toast("Copied", "ok"),
            () => ctx.toast("Failed to copy", "error")
          );
        });
        row.append(fix);
      }
      checks.append(row);
    }
  box.append(el("div", "group-head", "This machine"), checks);

  // The first operation, ticked off from real counts.
  const n = setup?.counts ?? { projects: 0, operations: 0, contacts: 0, launched: 0 };
  const steps = el("div", "ob-steps");
  steps.append(
    stepRow(
      n.operations > 0,
      "Start an operation",
      "Pick a repo (its settings are detected) and paste a Linear project link or a plan. An agent drafts the contacts; you review and create.",
      button("New operation", "plus", ctx.newOperation, true),
    ),
    stepRow(
      n.launched > 0,
      "Launch a mission",
      "On the Board, Launch opens an omp pane in a fresh worktree. Approve its plan in that pane; the board watches the rest and asks you when it needs something.",
      button("Open the Board", "layout-list", ctx.openBoard),
    ),
  );
  box.append(el("div", "group-head", "Your first operation"), steps);

  const foot = el("div", "list-tools left");
  foot.append(button("Take the tour", "map", ctx.startTour));
  box.append(foot);
  return box;
}

const TOUR = [
  ["#projectsCrumb", "Projects", "Every repo you run campaigns on, and its settings. Start here when something is about a whole project."],
  ["#op", "Operations", "The operation you are looking at. Grouped by project; New operation and the Archive are at the bottom of this list."],
  ["#toggle", "Three views", "Table is the radar, Board is the work list with the selected contact's card, Plan is the dependency map and the Operation page. Keys 1, 2, 3."],
  ["#needs", "Needs you", "Contacts waiting on a click or a decision. Click to jump to the first one."],
  ["#conn", "Connection", "Live while the board is reachable. It polls every few seconds; nothing here needs a refresh."],
  ["#settingsButton", "Settings and help", "Theme, the live omp cap, polling, defaults for new projects, and this tour again. Press ? for keyboard shortcuts."],
];

let activeEnd = null;
/** Coach marks over the header, one at a time; skips controls that are hidden right now. */
export function startTour() {
  if (activeEnd) activeEnd();
  localStorage.setItem(TOURED, "1");
  const steps = TOUR.filter(([sel]) => {
    const t = document.querySelector(sel);
    return t && !t.hidden && t.getClientRects().length > 0;
  });
  if (!steps.length) return;
  let i = 0;
  const ring = el("div", "tour-ring");
  const card = el("div", "tour-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-live", "polite");
  document.body.append(ring, card);
  const end = () => {
    ring.remove();
    card.remove();
    removeEventListener("resize", place);
    document.removeEventListener("keydown", onKey, true);
    activeEnd = null;
  };
  activeEnd = end;
  function place() {
    const target = document.querySelector(steps[i][0]);
    if (!target) return end();
    const r = target.getBoundingClientRect();
    Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
    const w = Math.min(320, innerWidth - 16);
    card.style.width = `${w}px`;
    card.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    card.style.top = `${r.bottom + 14}px`;
  }
  function show() {
    const [, title, text] = steps[i];
    const back = button("Back", null, () => go(-1));
    back.disabled = i === 0;
    const next = button(i === steps.length - 1 ? "Done" : "Next", null, () => go(1), true);
    const skip = el("button", "linkish", "Skip tour");
    skip.type = "button";
    skip.addEventListener("click", end);
    const nav = el("div", "tour-nav");
    nav.append(skip, el("span", "set-note", `${i + 1} / ${steps.length}`), back, next);
    card.replaceChildren(el("div", "ob-title", title), el("p", "set-note", text), nav);
    place();
    next.focus();
  }
  function go(d) {
    i += d;
    if (i >= steps.length) return end();
    i = Math.max(0, i);
    show();
  }
  function onKey(e) {
    e.stopPropagation();
    if (e.key === "Escape") end();
    else if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    else return;
    e.preventDefault();
  }
  addEventListener("resize", place);
  document.addEventListener("keydown", onKey, true);
  show();
}
