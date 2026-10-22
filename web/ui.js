// Shared building blocks: element helper, state words, action buttons.
// Every projection value lands via textContent/attributes, never innerHTML.
import { dropdown, el } from "./components.js";
import { icon } from "./icons.js";

export { el };

const STATE_WORDS = {
  ready: "Ready", blocked: "Blocked", decision: "Decision", planning: "Planning",
  running: "Running", verify: "Verify", review: "Review", hold: "Hold", complete: "Complete",
  conflict: "Conflict", landed: "Landed", offline: "Offline", waiting: "Waiting",
};

export function errorText(e) {
  return e instanceof Error ? e.message : String(e);
}

export async function fetchJson(res) {
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

/**
 * Store errors name the file and array index ("Invalid operation at /x/op.json: contacts[2].ticket …");
 * the operator only needs the reason.
 */
export function storeErrorText(error) {
  return error ? errorText(error).replace(/^Invalid \w+ at [^:]+: (?:\w+\[\d+\]\.)?/, "") : "";
}

export function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** "1 needs you", "3 need you": one wording for every attention count. */
export function needsYou(n) {
  return `${n} need${n === 1 ? "s" : ""} you`;
}

/** Progress bar; `fraction` is 0..1. */
export function meter(fraction, className = "meter") {
  const box = el("div", className);
  const fill = el("span", "");
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  box.append(fill);
  return box;
}

/** A button that copies `text`; it reads "Copied" for a moment, and a failure toasts. */
export function copyButton(label, text, { className = "btn small", toast } = {}) {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", () => {
    // No navigator.clipboard off a secure origin (a Tailscale URL over http): that is a failure too.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => {
          b.textContent = "Copied";
          setTimeout(() => {
            b.textContent = label;
          }, 1500);
        },
        () => toast?.("Failed to copy: select the text and copy it yourself", "error"),
      );
  });
  return b;
}

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]";

/**
 * Keeps Tab and Shift+Tab inside `container` (a dialog, drawer or panel); call it from the
 * container's keydown handler. Focus outside the container comes back in at the matching end.
 */
export function trapTab(container, e) {
  if (e.key !== "Tab") return;
  const items = [...container.querySelectorAll(FOCUSABLE)].filter(
    (n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length > 0,
  );
  const at = items.indexOf(document.activeElement);
  const edge = e.shiftKey ? 0 : items.length - 1;
  if (at !== -1 && at !== edge) return;
  e.preventDefault();
  items.at(e.shiftKey ? -1 : 0)?.focus();
}

export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function sectionBox(title, { cls = "section", count, note, headCls = "group-head" } = {}) {
  const s = el("section", cls);
  const head = el("div", headCls);
  const t = el("span", "", title);
  head.append(t);
  if (count !== undefined) head.append(el("span", "count", count));
  if (note) {
    const n = el("span", "note", note);
    head.append(n);
  }
  s.append(head);
  return { root: s, head, title: t };
}

export function safeLink(url, text = url) {
  if (!/^https?:\/\//i.test(url)) return document.createTextNode(text);
  const a = el("a", "", text);
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  return a;
}

const PULL_URL = /\/pull\/\d+(?:[/?#]|$)/i;

/** Tracker issue URL only. A pull-request URL is delivery, never the ticket. */
export function trackerIssueUrl(contact, tracker) {
  if (!tracker || tracker === "none") return null;
  const url = contact?.tracker?.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url) || PULL_URL.test(url)) return null;
  return url;
}

/** Opens the tracker issue. Never the delivery PR, and never a URL built from the ticket number. */
export async function openTicket(contact, tracker, notify, lookup) {
  let url = trackerIssueUrl(contact, tracker);
  let popup = null;
  if (!url && tracker && tracker !== "none" && typeof lookup === "function") {
    popup = window.open("", "_blank");
    if (popup) popup.opener = null;
    try {
      const fetched = await lookup(contact.ticket);
      if (typeof fetched === "string" && /^https?:\/\//i.test(fetched) && !PULL_URL.test(fetched)) url = fetched;
    } catch {
      url = null;
    }
  }
  if (url) {
    if (popup) popup.location.href = url;
    else window.open(url, "_blank", "noopener");
    return true;
  }
  popup?.close();
  const ticket = contact?.ticket ?? "Ticket";
  if (typeof notify === "function") {
    notify(tracker === "none" ? `${ticket}: this operation has no tracker` : `${ticket} has no tracker link`);
  }
  return false;
}

const KIND_LABEL = {
  implement: "Implement",
  audit: "Audit",
  decision: "Decision",
  conflict: "Conflict",
  closer: "Closer",
};

export function kindPill(kind) {
  const known = Object.hasOwn(KIND_LABEL, kind);
  return el("span", `pill kind-pill${known ? ` k-${kind}` : ""}`, KIND_LABEL[kind] ?? kind);
}

// Icon per contact state, inside the pill. Kept monochrome: colour carries the state.
const STATE_ICON = {
  ready: "clock", blocked: "lock", decision: "message-circle-question", planning: "pen-line",
  running: "activity", verify: "shield-check", review: "eye", hold: "pause", complete: "check",
  conflict: "triangle-alert", landed: "git-merge", offline: "wifi-off", waiting: "clock",
};

export function stateLabel(contact) {
  const { state, problem, hold, phase } = contact;
  if (state === "offline" || state === "landed") return STATE_WORDS[state];
  if (state === "hold" && hold === "question") return "Question";
  if (problem?.kind === "quota") return "Quota exhausted";
  if (contact.review && Date.parse(contact.review.deadlineAt) <= Date.now()) return "Review stalled";
  if (problem?.kind === "rate-limit") return "Rate limited";
  if (problem && state === "waiting") return "Retry scheduled";
  if (state === "hold" && hold === "plan-approval") return "Plan";
  if (state === "hold" && phase === "verify") return "Verify";
  if (problem && state === "hold") return "Failed";
  return STATE_WORDS[state] ?? state;
}

export function statePill(contact) {
  const { state, problem, hold, phase } = contact;
  const presentation = state === "hold"
    ? hold === "question" ? "decision" : hold === "plan-approval" ? "planning" : phase === "verify" ? "verify" : state
    : state;
  const pill = el("span", `pill s-${problem ? "hold" : state}`);
  if (STATE_ICON[presentation]) pill.append(icon(STATE_ICON[presentation], { size: 10 }));
  pill.append(document.createTextNode(stateLabel(contact)));
  return pill;
}

export function fmtMs(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

const pad = (n) => String(n).padStart(2, "0");

/** Local time of day, 24-hour: "19:01", or "19:01:08" with seconds. The one clock every view uses. */
export function clock(iso, { seconds = false } = {}) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return `${pad(t.getHours())}:${pad(t.getMinutes())}${seconds ? `:${pad(t.getSeconds())}` : ""}`;
}

/** Local date and time: "Oct 21, 2026 19:01". */
export function dateTime(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  return `${t.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} ${clock(t)}`;
}

// Action ids the server handles via POST /api/actions. plan-save/plan-refine are wired but
// render inside the Plan tab, not the action bar (card.js filters them).
const WIRED = new Set(["launch", "reap", "approve", "continue", "review", "dispatch", "check", "resend", "release", "retry-model", "mode", "focus", "done", "land", "land-anyway", "relaunch", "redecide", "decide-agent", "plan-save", "plan-refine", "answer", "permit"]);
// Shown while the request runs; launch and land can take a while against real tools.
const BUSY_LABEL = {
  launch: "Launching…", land: "Landing…", "land-anyway": "Landing…", approve: "Approving…", continue: "Continuing…",
  review: "Requesting…", dispatch: "Dispatching…", check: "Checking…", done: "Saving…", reap: "Closing…", focus: "Focusing…", mode: "Setting…", relaunch: "Reopening…", "decide-agent": "Opening…", redecide: "Saving…",
  "plan-save": "Saving…", "plan-refine": "Refining…", answer: "Sending…", permit: "Sending…",
  resend: "Resending…", release: "Releasing…",
};

// Icon per action id, drawn before the label.
const ACTION_ICON = {
  launch: "rocket", land: "git-merge", "land-anyway": "git-merge", approve: "check", continue: "skip-forward", review: "eye",
  dispatch: "send", done: "check-check", reap: "circle-x", focus: "crosshair", relaunch: "rotate-cw", "decide-agent": "bot", redecide: "pencil",
  resend: "rotate-cw", release: "skip-forward", "retry-model": "rotate-cw", check: "git-branch",
};
// Actions that end something the operator cannot get back; they need a second click.
export const CONFIRM = { reap: "Close terminal?", "land-anyway": "Merge with failing checks?" };
// Land anyway while CI has not finished: the board labels that variant "Skip CI and land".
export const SKIP_CI = {
  label: "Skip CI and land",
  confirm: "CI hasn't finished; GitHub will merge without it",
  tip: "Merge this PR without waiting for its checks (click twice); GitHub branch protection still applies",
  past: "landed without waiting for CI",
};

/** The action an operator most likely wants next for this contact, if it can run now. */
export function primaryAction(contact) {
  // Mode, answer and permit need arguments the card collects; a bare click cannot run them.
  return contact.actions.find((a) => a.primary && a.enabled && WIRED.has(a.id) && a.id !== "mode" && a.id !== "answer" && a.id !== "permit") ?? null;
}

/**
 * ctx: { onAction(contact, id, args), busy: Set<"ticket/id">, confirming: string|null }
 * Buttons carry data-key so focus survives re-renders.
 */
// What each action does, for its tooltip; disabled buttons add why they are off.
const ACTION_TIPS = {
  launch: "Create a worktree and open a mission pane for this contact",
  approve: "Approve the Pause gate the mission is waiting at",
  continue: "Take control of the mission again (after a restart, a lost lock, or failed verification you have looked at)",
  relaunch: "Reopen this mission's pane in its worktree; the mission comes back in resume hold until continued",
  review: "Ask the mission for a review round",
  dispatch: "Dispatch the next ready work to workers",
  check: "Inspect the delivered PR: update it from the base, work through review threads and conflicts, reply to reviewers (the mission pane does the work)",
  resend: "Retry the stopped worker through its mission controller",
  release: "Ask the mission controller to release its blocker",
  focus: "Bring this mission's terminal to the front",
  reap: "Close this mission's terminal (click twice)",
  land: "Merge this contact's branch into the integration checkout, or merge its PR",
  "land-anyway": "Merge this PR although its checks are failing (click twice); GitHub branch protection still applies",
  done: "Mark finished once its work is really merged into the base; anything waiting on it can start",
  "decide-agent": "Open an omp pane that investigates this question and records a choice with its reasoning",
  redecide: "Record a different choice; anything that waited on this stays unblocked",
};

export function actionButton(contact, action, ctx, extraClass = "") {
  const key = `${contact.ticket}/${action.id}`;
  if (action.id === "mode") return modeSelect(contact, action, ctx, key);
  const busy = ctx.busy.has(key);
  const confirming = ctx.confirming === key;
  const cls = [
    "btn",
    action.primary ? "primary" : "",
    CONFIRM[action.id] ? "danger" : "",
    confirming ? "confirming" : "",
    extraClass,
  ].filter(Boolean).join(" ");
  const skipsCi = action.id === "land-anyway" && action.label === SKIP_CI.label;
  const confirmText = skipsCi ? SKIP_CI.confirm : CONFIRM[action.id];
  const label = busy ? (BUSY_LABEL[action.id] ?? "Working…") : confirming ? confirmText : action.label;
  const btn = el("button", cls);
  if (ACTION_ICON[action.id] && !busy) btn.append(icon(ACTION_ICON[action.id], { size: 13 }));
  btn.append(document.createTextNode(label));
  btn.type = "button";
  btn.dataset.key = key;
  btn.dataset.action = action.id;
  btn.dataset.ticket = contact.ticket;
  btn.disabled = !action.enabled || busy || ctx.busy.has(`${contact.ticket}/*`);
  const tipText = skipsCi ? SKIP_CI.tip : ACTION_TIPS[action.id];
  if (!action.enabled && action.reason) btn.title = tipText ? `${tipText}\nUnavailable: ${action.reason}` : action.reason;
  else if (tipText) btn.title = tipText;
  if (busy) btn.setAttribute("aria-busy", "true");
  return btn;
}

const MODES = [
  { value: "auto", label: "Auto", hint: "run to the end" },
  { value: "pause", label: "Pause", hint: "stop at Pause gates" },
  { value: "force", label: "Force", hint: "skip holds" },
];

/** Shows the mission's current mode; picking another one changes it. */
function modeSelect(contact, action, ctx, key) {
  const current = contact.mode ?? null;
  const dd = dropdown({
    className: "dd-mode",
    label: `Mission mode for ${contact.ticket}`,
    placeholder: "Mode",
    options: MODES.map((m) => ({ ...m, label: `Mode: ${m.label}` })),
    value: current,
    onChange: (mode) => {
      if (mode !== current) ctx.run(contact.ticket, "mode", { mode });
    },
  });
  dd.btn.classList.add("btn");
  dd.btn.dataset.key = key;
  dd.setDisabled(!action.enabled || ctx.busy.has(key) || ctx.busy.has(`${contact.ticket}/*`));
  const what = "Auto runs to the end, Pause stops at each Pause gate for your approval, Force skips holds";
  dd.btn.title = !action.enabled && action.reason ? `${what}\nUnavailable: ${action.reason}` : what;
  return dd.root;
}

export function isWired(action) {
  return WIRED.has(action.id);
}

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
export const KEY_DIR = {
  w: "up", k: "up", ArrowUp: "up",
  s: "down", j: "down", ArrowDown: "down",
  a: "left", h: "left", ArrowLeft: "left",
  d: "right", l: "right", ArrowRight: "right",
};

/**
 * The point to move to when pressing a direction: within 60° of it, preferring close and on-axis.
 * Falls back to the widest cone (anything in that half-plane) so a key press is never a dead end.
 */
export function nearestInDirection(points, from, dir) {
  const [dx, dy] = DIRS[dir];
  let best = null;
  let bestScore = Infinity;
  for (const p of points) {
    if (p.ticket === from.ticket) continue;
    const vx = p.x - from.x;
    const vy = p.y - from.y;
    const dist = Math.hypot(vx, vy);
    if (dist < 1) continue;
    const along = (vx * dx + vy * dy) / dist; // cos of the angle to the pressed direction
    if (along <= 0) continue;
    const off = Math.acos(Math.min(1, along));
    const score = dist * (1 + (off > Math.PI / 3 ? 4 : 0) + off * 1.5);
    if (score < bestScore) {
      bestScore = score;
      best = p.ticket;
    }
  }
  return best;
}
