// The contact card: what this contact is, what happens next, what the operator can do.
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { modelDropdown } from "./models.js";
import { ago } from "./plan.js";
import { actionButton, clock, el, isWired, safeLink, statePill } from "./ui.js";

const OWNER_COPY = {
  live: ["live", "Mission session connected"],
  observed: ["live", "Mission reports activity; board control is unavailable in this manually restarted pane"],
  offline: ["offline", "Mission session not answering: showing its last snapshot"],
};

// Plan-panel UI state survives region rebuilds; keyed by operation + ticket.
const planUi = new Map();
const planState = (opId, ticket) => {
  const key = `${opId}/${ticket}`;
  let s = planUi.get(key);
  if (!s) {
    s = { mode: "read", draft: "", refine: "", stale: false };
    planUi.set(key, s);
  }
  return s;
};
/** Digest of plan-panel UI state so region() rebuilds when it changes. Drafts stay out: typing must not rebuild the textarea. */
export function planUiKey(opId, ticket) {
  const s = planUi.get(`${opId}/${ticket}`);
  return s ? `${s.mode}:${s.stale}` : "";
}

function header(contact, zoneLabel) {
  const head = el("div", "card-head");
  const line = el("div", "card-tags");
  line.append(el("span", "mono", contact.ticket));
  if (zoneLabel) line.append(el("span", "tag", zoneLabel));
  if (contact.kind !== "implement") line.append(el("span", "tag", contact.kind));
  head.append(line);

  const titleText = contact.title ?? contact.ticket;
  const titleEl = el("h2", "card-title", titleText);
  head.append(titleEl);
  const status = el("div", "card-status");
  status.append(statePill(contact));
  const owner = OWNER_COPY[contact.owner];
  if (owner) {
    const dot = el("span", `owner o-${owner[0]}`);
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", owner[1]);
    dot.title = owner[1];
    status.append(dot);
  }
  head.append(status);

  const desc = contact.description ?? null;
  if (desc && desc.trim()) {
    const descEl = el("div", "card-desc");
    descEl.append(renderMarkdown(desc));
    head.append(descEl);
  }
  return head;
}

function progress(contact) {
  if (!contact.progress || !contact.progress.of) return null;
  const { step, of } = contact.progress;
  const box = el("div", "progress");
  const bar = el("div", "rail");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", String(of));
  bar.setAttribute("aria-valuenow", String(Math.min(step + 1, of)));
  for (let i = 0; i < of; i += 1) bar.append(el("span", `seg${i < step ? " done" : i === step ? " now" : ""}`));
  const label = el("div", "progress-label");
  label.append(el("b", "", contact.phase ?? "phase"), document.createTextNode(` · step ${Math.min(step + 1, of)} of ${of}`));
  box.append(bar, label);
  return box;
}

/** Small button that opens the contact's Plan tab; the board's door into plan review. */
function reviewPlanButton(contact, cls = "") {
  const btn = el("button", `btn primary${cls ? ` ${cls}` : ""}`);
  btn.type = "button";
  btn.append(icon("file-text", { size: 13 }), document.createTextNode("Review plan"));
  btn.dataset.id = contact.ticket;
  btn.dataset.cardtab = "plan";
  btn.dataset.key = `review-plan/${contact.ticket}`;
  return btn;
}

const launchModels = new Map();
export function getLaunchModel(opId, ticket) {
  return launchModels.get(`${opId}/${ticket}`);
}
export function clearLaunchModel(opId, ticket) {
  launchModels.delete(`${opId}/${ticket}`);
}

const decideModels = new Map();
export function getDecideModel(opId, ticket) {
  return decideModels.get(`${opId}/${ticket}`);
}
export function clearDecideModel(opId, ticket) {
  decideModels.delete(`${opId}/${ticket}`);
}

function actionBar(contact, ctx) {
  const modelKey = `${ctx.opId}/${contact.ticket}`;
  // plan-save/plan-refine render inside the Plan tab, never the action bar.
  const wired = contact.actions.filter((a) => isWired(a) && !a.id.startsWith("plan-"));
  const wrap = el("div", "");
  if (!wired.length && !contact.plan) return null;
  const box = el("div", "actions");
  const main = el("div", "actions-main");
  const aside = el("div", "actions-aside");
  // Primary first, then the rest; Reap sits apart so it is never the button under your thumb.
  const rank = (a) => (a.primary ? 0 : a.enabled ? 1 : 2);
  const ordered = [...wired].sort((a, b) => rank(a) - rank(b));
  for (const a of ordered) {
    const target = a.id === "reap" ? aside : main;
    target.append(actionButton(contact, a, ctx));
    if (a.id === "launch" && a.enabled && ctx.api) {
      const dd = modelDropdown({
        api: ctx.api,
        value: launchModels.has(modelKey) ? launchModels.get(modelKey) ?? "" : null,
        label: `Model for ${contact.ticket}`,
        allowInherit: true,
        inheritLabel: "Default model",
        defaultModel: ctx.ai?.mission ?? ctx.ai?.model ?? null,
        placeholder: "Model",
        className: "action-model-dd",
        onChange: (v) => {
          if (v === null) launchModels.delete(modelKey);
          else launchModels.set(modelKey, v === "" ? null : v);
        },
      });
      target.append(dd.root);
    } else if (a.id === "decide-agent" && a.enabled && ctx.api) {
      const dd = modelDropdown({
        api: ctx.api,
        value: decideModels.has(modelKey) ? decideModels.get(modelKey) ?? "" : null,
        label: `Model for decision agent on ${contact.ticket}`,
        allowInherit: true,
        inheritLabel: "Default model",
        defaultModel: ctx.ai?.decision ?? ctx.ai?.model ?? null,
        placeholder: "Model",
        className: "action-model-dd",
        onChange: (v) => {
          if (v === null) decideModels.delete(modelKey);
          else decideModels.set(modelKey, v === "" ? null : v);
        },
      });
      target.append(dd.root);
    }
  }
  if (contact.plan) main.prepend(reviewPlanButton(contact));
  box.append(main, aside);
  wrap.append(box);
  const reasons = el("ul", "reasons");
  for (const a of wired)
    if (!a.enabled && a.reason && (a.primary || a.id === "launch" || a.id === "land")
      && contact.state !== "waiting"
      && !(a.id === "launch" && contact.state === "blocked" && a.reason.startsWith("blocked by ")))
      reasons.append(el("li", "", `${a.label} unavailable: ${a.reason}`));
  if (reasons.childElementCount) wrap.append(reasons);
  return wrap;
}


function prLabel(url) {
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  return n ? `PR #${n}` : "Pull request";
}

/** Every row always shows; a missing value says why instead of vanishing. */
function facts(contact, projection) {
  const op = projection.operation;
  const root = el("div", "facts-groups");
  const group = (title) => {
    const sec = el("section", "facts-group");
    sec.append(el("div", "kicker", title));
    const grid = el("dl", "facts");
    sec.append(grid);
    root.append(sec);
    return (label, value) => {
      const wrap = el("div", "");
      const dd = el("dd", "");
      if (value === null) dd.append(el("span", "none", "—"));
      else if (Array.isArray(value)) dd.append(el("span", "none", value[0]));
      else if (typeof value === "string") dd.textContent = value;
      else dd.append(value);
      wrap.append(el("dt", "", label), dd);
      grid.append(wrap);
    };
  };

  const ticket = group("Ticket");
  ticket("Origin", contact.origin ? `${contact.origin.text} · ${ago(contact.origin.at)}` : ["not recorded"]);
  ticket("Kind", contact.kind);
  if (op.tracker === "none") ticket("Tracker", ["this operation has no tracker"]);
  else if (contact.tracker)
    ticket("Tracker", contact.tracker.url ? safeLink(contact.tracker.url, contact.tracker.state) : contact.tracker.state);
  else ticket("Tracker", [`not checked yet (${op.tracker})`]);

  const delivery = group("Delivery");
  if (op.delivery === "none") delivery("Pull request", ["this operation has no delivery"]);
  else if (contact.delivery) {
    const d = contact.delivery;
    const box = el("span", "chips");
    if (d.url) box.append(safeLink(d.url, prLabel(d.url)));
    box.append(el("span", `chip c-${d.state}`, d.state));
    if (d.mergeable !== "unknown") box.append(el("span", `chip c-${d.mergeable}`, d.mergeable === "clean" ? "mergeable" : d.mergeable));
    if (d.checks !== "none") box.append(el("span", `chip c-${d.checks}`, `checks ${d.checks}`));
    delivery("Pull request", box);
  } else delivery("Pull request", [contact.lane ? "none yet: appears when the mission delivers" : "none: not launched"]);
  const checkChip = { clean: "c-clean", merged: "c-merged", closed: "c-closed", conflict: "c-conflict", threads: "c-pending", checks: "c-fail", fixing: "c-pending", unknown: "c-unknown" };
  if (contact.check) {
    const c = contact.check;
    const box = el("span", "chips");
    box.append(el("span", `chip ${checkChip[c.state] ?? ""}`, c.state));
    const tail = [c.detail, ago(c.at)].filter(Boolean).join(" · ");
    if (tail) box.append(el("span", "dim", tail));
    delivery("Last check", box);
  }


  const lane = group("Lane");
  if (!contact.lane) {
    lane("Worktree", ["not created: the contact has not launched"]);
    lane("Terminal", ["none"]);
  } else {
    lane("Branch", contact.lane.branch ? el("span", "mono", contact.lane.branch) : ["not recorded"]);
    const wt = el("span", "mono ellipsis", contact.lane.worktree);
    wt.title = contact.lane.worktree;
    lane("Worktree", wt);
    lane("Terminal", contact.lane.frontend === "external" ? ["adopted checkout, no terminal"] : contact.lane.terminal ? `open in ${contact.lane.frontend}` : ["none"]);
  }
  lane("Workers", contact.workers ? `${contact.workers.live} running of ${contact.workers.total}` : ["none reported"]);
  lane("Model", contact.model ? el("span", "mono", contact.model) : ["not reported"]);
  if (contact.review) {
    const r = contact.review;
    const stale = Date.parse(r.deadlineAt) <= Date.now();
    lane("Review", `${r.completed}/${r.total} targets done, ${r.active} running${r.models.length ? ` on ${r.models.join(", ")}` : ""}${stale ? ` — stalled past ${new Date(r.deadlineAt).toLocaleString()}` : ` · deadline ${new Date(r.deadlineAt).toLocaleString()}`}`);
  }
  return root;
}

function relations(contact, projection) {
  const box = el("div", "relations");
  if (contact.blockedBy.length) {
    const head = el("div", "kicker", "Waits for");
    const list = el("div", "rel-list");
    for (const b of contact.blockedBy) {
      const btn = el("button", `rel${b.landed ? " ok" : ""}`, b.ticket);
      btn.title = b.landed ? "Landed" : "Not landed";
      btn.type = "button";
      btn.dataset.id = b.ticket;
      btn.dataset.key = `rel/${b.ticket}`;
      list.append(btn);
    }
    box.append(head, list);
  }
  const dependents = projection.contacts.filter((c) => c.blockedBy.some((b) => b.ticket === contact.ticket));
  if (dependents.length) {
    const list = el("div", "rel-list");
    for (const d of dependents) {
      const btn = el("button", "rel", d.ticket);
      btn.type = "button";
      btn.dataset.id = d.ticket;
      btn.dataset.key = `rel/${d.ticket}`;
      list.append(btn);
    }
    box.append(el("div", "kicker", "Unblocks when landed"), list);
  }
  const conflicts = projection.contacts.filter((c) => c.conflictOf === contact.ticket);
  if (contact.conflictOf || conflicts.length) {
    const note = el("div", "conflict-note");
    if (contact.conflictOf) {
      note.append(el("p", "", `Resolves the merge conflicts from landing ${contact.conflictOf}. It edits only the conflicted files; when it completes, Land on ${contact.conflictOf} merges this branch.`));
      const btn = el("button", "rel", `Open ${contact.conflictOf}`);
      btn.type = "button";
      btn.dataset.id = contact.conflictOf;
      btn.dataset.key = `rel/${contact.conflictOf}`;
      note.append(btn);
    } else if (contact.state !== "conflict") {
      note.append(el("p", "", `Merge conflicts from an earlier Land were resolved by ${conflicts.map((c) => c.ticket).join(", ")}.`));
    } else {
      note.append(el("p", "", "Land hit merge conflicts. A conflict mission is resolving them in its own worktree; this contact stays and Land reopens when it completes. It is not a second copy of the ticket."));
    }
    if (!contact.conflictOf) {
      const list = el("div", "rel-list");
      for (const c of conflicts) {
        const btn = el("button", "rel", `${c.ticket} · ${c.state}`);
        btn.type = "button";
        btn.dataset.id = c.ticket;
        btn.dataset.key = `rel/${c.ticket}`;
        list.append(btn);
      }
      note.append(list);
    }
    box.append(el("div", "kicker", "Conflict"), note);
  }
  return box.childElementCount ? box : null;
}

/** This contact's full history; entries come from GET /api/history, newest first. */
function historyTab(contact, entries) {
  if (entries === null) return el("div", "empty-line", "Loading history…");
  const mine = entries.filter((e) => e.contact === contact.ticket);
  if (!mine.length) return el("div", "empty-line", "No events yet.");
  const list = el("ol", "timeline-list");
  for (const l of mine) {
    const li = el("li", l.cls);
    const text = l.text.startsWith(contact.ticket) ? l.text.slice(contact.ticket.length).trim() : l.text;
    li.append(el("time", "", `${clock(l.at)}`), el("span", `actor a-${l.actor}`, l.actor === "operator" ? "you" : l.actor), el("span", "", text));
    li.title = new Date(l.at).toLocaleString();
    list.append(li);
  }
  return list;
}

// ---- plan tab ----

function planButton(iconName, label, cls = "") {
  const btn = el("button", `btn small${cls ? ` ${cls}` : ""}`);
  btn.type = "button";
  btn.append(icon(iconName, { size: 13 }), document.createTextNode(label));
  return btn;
}

/**
 * The plan the mission proposed, fetched via GET /api/plan. `data` is the app's cache
 * entry: null while loading, {error} on failure, else {text, path, revision}.
 * Editing goes through the plan-save action (server-side plan-edit with a base
 * revision); Refine asks the mission to revise. Approval itself stays in the pane.
 */
function planTab(contact, data, ctx, projection) {
  const opId = projection.operation.id;
  const ui = planState(opId, contact.ticket);
  const box = el("div", "plan-panel");
  const save = contact.actions.find((a) => a.id === "plan-save");
  const refine = contact.actions.find((a) => a.id === "plan-refine");
  const focus = contact.actions.find((a) => a.id === "focus");
  const editable = (a) => Boolean(a?.enabled);
  const why = (a, fallback) => (a?.enabled ? null : a?.reason ?? fallback);

  if (!data) {
    box.append(el("div", "empty-line", "Loading the plan…"));
    return box;
  }
  if (data.error) {
    box.append(el("div", "set-err big", `Cannot load the plan: ${data.error}`));
    const reload = planButton("rotate-cw", "Reload");
    reload.addEventListener("click", () => ctx.refreshPlan());
    box.append(reload);
    return box;
  }

  const head = el("div", "plan-head");
  head.append(el("span", "mono ellipsis", data.path), el("span", "tag", `rev ${data.revision.slice(0, 8)}`));
  box.append(head);

  if (ui.mode === "edit") {
    const area = el("textarea", "plan-edit");
    if (ui.mode === "edit" && data.revision !== ui.base) ui.stale = true;
    area.value = ui.draft || data.text;
    area.spellcheck = false;
    area.setAttribute("aria-label", `Edit plan for ${contact.ticket}`);
    area.dataset.key = `plan/edit/${contact.ticket}`;
    area.addEventListener("input", () => {
      ui.draft = area.value;
    });
    box.append(area);
    if (ui.stale) {
      const warn = el("div", "plan-stale");
      warn.append(
        icon("triangle-alert", { size: 13 }),
        document.createTextNode("The mission rewrote the plan while you edited. Reload to see its version, or overwrite it."),
      );
      const reload = planButton("rotate-cw", "Reload");
      reload.addEventListener("click", () => {
        ui.stale = false;
        ui.mode = "read";
        ui.draft = "";
        ctx.refreshPlan();
      });
      const over = planButton("save", "Overwrite");
      over.classList.add("danger");
      over.disabled = !editable(save) || ctx.busy.has(`${contact.ticket}/*`);
      over.addEventListener("click", async () => {
        const res = await ctx.run(contact.ticket, "plan-save", { text: area.value });
        if (res?.ok) {
          ui.stale = false;
          ui.mode = "read";
          ui.draft = "";
          ctx.refreshPlan();
        }
      });
      warn.append(reload, over);
      box.append(warn);
    }
    const row = el("div", "actions plan-row");
    const saveBtn = planButton("save", "Save", "primary");
    saveBtn.disabled = !editable(save) || ctx.busy.has(`${contact.ticket}/*`);
    if (!editable(save)) saveBtn.title = why(save, "the mission is not accepting edits");
    saveBtn.addEventListener("click", async () => {
      const res = await ctx.run(contact.ticket, "plan-save", { text: area.value, revision: ui.base });
      if (res?.ok) {
        ui.mode = "read";
        ui.draft = "";
        ui.stale = false;
        ctx.refreshPlan();
      } else if (/^stale:/.test(res?.error ?? "")) {
        ui.stale = true;
        ui.draft = area.value;
        ctx.rerender();
      }
    });
    const cancel = planButton("x", "Cancel");
    cancel.addEventListener("click", () => {
      ui.mode = "read";
      ui.draft = "";
      ui.stale = false;
      ctx.rerender();
    });
    row.append(saveBtn, cancel);
    box.append(row);
    return box;
  }

  box.append(renderMarkdown(data.text));

  if (ui.mode === "refine") {
    const wrap = el("div", "plan-compose");
    wrap.append(el("div", "kicker", "Ask the mission to revise"));
    wrap.append(el("div", "set-note", "Refinements use this mission's active session and model."));
    const area = el("textarea", "");
    area.value = ui.refine;
    area.rows = 4;
    area.placeholder = "What should change? The mission rewrites the plan and proposes it again.";
    area.setAttribute("aria-label", `Refine plan for ${contact.ticket}`);
    area.dataset.key = `plan/refine/${contact.ticket}`;
    const foot = el("div", "plan-compose-foot");
    const send = planButton("send", "Send to mission", "primary");
    const blocked = !editable(refine) || ctx.busy.has(`${contact.ticket}/*`);
    if (!editable(refine)) send.title = why(refine, "the mission is not accepting refinements");
    const sync = () => {
      send.disabled = blocked || !area.value.trim();
    };
    sync();
    const submit = async () => {
      if (send.disabled) return;
      const res = await ctx.run(contact.ticket, "plan-refine", { message: area.value.trim() });
      if (res?.ok) {
        ui.mode = "read";
        ui.refine = "";
        ctx.rerender();
      }
    };
    area.addEventListener("input", () => {
      ui.refine = area.value;
      sync();
    });
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submit();
      }
    });
    send.addEventListener("click", submit);
    const cancel = planButton("x", "Cancel");
    cancel.addEventListener("click", () => {
      ui.mode = "read";
      ctx.rerender();
    });
    foot.append(el("span", "hint", "Ctrl+Enter sends"), cancel, send);
    wrap.append(area, foot);
    box.append(wrap);
    if (ui.focusRefine) {
      ui.focusRefine = false;
      queueMicrotask(() => area.focus());
    }
    return box;
  }

  const row = el("div", "actions plan-row");
  const edit = planButton("pencil", "Edit");
  edit.disabled = !editable(save) || ui.mode !== "read" || ctx.busy.has(`${contact.ticket}/*`);
  if (!editable(save)) edit.title = why(save, "the mission is not accepting edits");
  edit.addEventListener("click", () => {
    ui.mode = "edit";
    ui.base = data.revision;
    ui.draft = data.text;
    ctx.rerender();
  });
  const refineBtn = planButton("sparkles", "Refine");
  refineBtn.disabled = !editable(refine) || ui.mode !== "read" || ctx.busy.has(`${contact.ticket}/*`);
  if (!editable(refine)) refineBtn.title = why(refine, "the mission is not accepting refinements");
  refineBtn.addEventListener("click", () => {
    ui.mode = "refine";
    ui.focusRefine = true;
    ctx.rerender();
  });
  row.append(edit, refineBtn);

  const planApproval = contact.actions.find((a) => a.id === "plan-approve");
  const canApprove = editable(planApproval);
  const approve = planButton("check", canApprove ? "Approve plan" : "Approve in pane", "primary");
  approve.disabled = canApprove ? ctx.busy.has(`${contact.ticket}/*`) : !editable(focus);
  if (!canApprove) approve.title = "No native plan review is available. Open /plan-review in the mission pane; older OMP sessions need updating and relaunching.";
  approve.addEventListener("click", () => canApprove
    ? ctx.run(contact.ticket, "plan-approve", { revision: data.revision })
    : ctx.run(contact.ticket, "focus", { purpose: "plan-approval" }));
  row.append(approve);
  // Dropping an unwanted plan is decided here too; Reap keeps its two-click confirm.
  const reap = contact.actions.find((a) => a.id === "reap");
  if (reap) {
    const aside = el("span", "plan-aside");
    aside.append(actionButton(contact, reap, ctx));
    row.append(aside);
  }
  box.append(row);
  box.append(
    el("div", "set-note plan-note", canApprove
      ? "Approve plan starts the mission with compacted context. Saved edits are included; Refine returns feedback to native plan mode."
      : "No native review is ready. Open /plan-review in the mission pane. If it runs older OMP, update to 18.10.4 or newer and relaunch it."),
  );
  return box;
}

export const CARD_TABS = [
  ["overview", "Overview"],
  ["plan", "Plan"],
  ["details", "Details"],
  ["history", "History"],
];

/** Tabs this contact actually has; Plan only while a pending plan is on disk. */
export function cardTabs(contact) {
  return CARD_TABS.filter(([id]) => id !== "plan" || contact?.plan);
}

export function renderCard(root, projection, contact, ctx, tab, entries, plan) {
  root.replaceChildren();
  if (!contact) {
    root.append(el("div", "placeholder", projection.contacts.length ? "Select a contact." : "No contacts yet. Add one with /holotable add <ticket> --zone <id>."));
    return;
  }
  const zone = projection.operation.zones.find((z) => z.id === contact.zone)?.label;
  root.append(header(contact, zone));

  const active = contact.plan || tab !== "plan" ? tab : "overview";

  const tabs = el("div", "tabs");
  tabs.setAttribute("role", "tablist");
  for (const [id, label] of cardTabs(contact)) {
    const b = el("button", "tab-btn", label);
    b.type = "button";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(id === active));
    b.dataset.cardtab = id;
    b.dataset.key = `tab/${id}`;
    tabs.append(b);
  }
  root.append(tabs);
  const body = el("div", "tab-body");
  body.setAttribute("role", "tabpanel");
  root.append(body);

  if (active === "details") {
    body.append(facts(contact, projection));
    return;
  }
  if (active === "history") {
    body.append(historyTab(contact, entries));
    return;
  }
  if (active === "plan") {
    body.append(planTab(contact, plan, ctx, projection));
    return;
  }
  const bar = progress(contact);
  if (bar) body.append(bar);
  if (contact.state !== "blocked") {
    const problem = contact.problem;
    const next = el("div", `next s-${problem ? "hold" : contact.state}`);
    const message = problem?.retryAt
      ? `Review paused. Automatic retry: ${new Date(problem.retryAt).toLocaleString()}.`
      : contact.detail;
    next.append(el("div", "kicker", contact.state === "waiting" && problem ? "Retry scheduled" : contact.attention ? "Your move" : "Status"), el("div", "next-text", message));
    if (problem?.completed !== null && problem?.completed !== undefined && problem.total !== null)
      next.append(el("div", "set-note", `${problem.completed}/${problem.total} reviewers retained${problem.attempt ? ` · failed attempt ${problem.attempt}` : ""}`));
    if (contact.review)
      next.append(el("div", "set-note", `${contact.review.completed}/${contact.review.total} reviewers finished · ${contact.review.active} running${contact.review.models.length ? ` on ${contact.review.models.join(", ")}` : ""}`));
    if (problem && problem.detail !== contact.detail) {
      const details = el("details", "mission-error");
      details.append(el("summary", "", "Failure details"), el("pre", "", problem.detail));
      next.append(details);
    }
    body.append(next);
  }
  const decided = decisionBox(contact, projection.operation.id);
  if (decided) body.append(decided);
  for (const part of [actionBar(contact, ctx), relations(contact, projection)]) if (part) body.append(part);
}

// The operator's tentative pick on a decision card survives region re-renders; the decision
// itself is only recorded after they confirm it in the "Mark decided" dialog.
const cardChoices = new Map();
const choiceKey = (opId, ticket) => `${opId}/${ticket}`;
export function getCardDecision(opId, ticket) {
  return cardChoices.get(choiceKey(opId, ticket)) ?? null;
}
export function clearCardDecision(opId, ticket) {
  cardChoices.delete(choiceKey(opId, ticket));
}

const DECIDED_BY = { operator: "you", agent: "an agent", recommended: "its recommendation" };

/** A decision contact's question options before it is decided, its answer and reasoning after. */
function decisionBox(contact, opId) {
  if (contact.kind !== "decision") return null;
  const box = el("div", "decision-box");
  if (contact.decision) {
    const d = contact.decision;
    box.append(el("div", "kicker", `Decided by ${DECIDED_BY[d.by] ?? d.by}`), el("div", "decision-choice", d.choice));
    if (d.rationale) box.append(renderMarkdown(d.rationale));
    return box;
  }
  if (contact.decisionPane)
    box.append(el("div", "set-note", "An agent is investigating this in an omp pane; its choice and reasoning will appear here."));
  if (!contact.options?.length) return contact.decisionPane ? box : null;
  box.append(el("div", "kicker", "Options"));
  const options = contact.options;
  const key = choiceKey(opId, contact.ticket);
  let choice = cardChoices.get(key) ?? null;
  if (choice !== null && !options.includes(choice)) {
    cardChoices.delete(key);
    choice = null;
  }

  const validRec =
    typeof contact.recommended === "string" && contact.recommended.length > 0 && options.includes(contact.recommended)
      ? contact.recommended
      : null;

  const radios = [];
  let pickBtn = null;
  const updatePick = (value) => {
    pickBtn?.setAttribute("aria-pressed", String(value === validRec));
  };
  const select = (value) => {
    choice = value;
    cardChoices.set(key, value);
    for (const r of radios) r.checked = r.value === value;
    updatePick(value);
  };

  if (validRec) {
    const recBar = el("div", "decide-rec");
    const recInfo = el("div", "decide-rec-info");
    recInfo.append(el("span", "decide-rec-kicker", "Recommended"), el("span", "decide-rec-val", validRec));
    pickBtn = el("button", "btn small decide-rec-btn");
    pickBtn.type = "button";
    pickBtn.append(icon("sparkles", { size: 13 }), document.createTextNode("Pick recommended"));
    pickBtn.setAttribute("aria-label", `Pick recommended: ${validRec}`);
    pickBtn.addEventListener("click", () => {
      radios[options.indexOf(validRec)]?.focus();
      select(validRec);
    });
    recBar.append(recInfo, pickBtn);
    box.append(recBar);
  }

  const list = el("fieldset", "decide-opts");
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", "Choice");
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const optId = `card-decide-${i}-${Math.random().toString(36).slice(2, 6)}`;
    const row = el("label", "decide-opt");
    row.htmlFor = optId;

    const radio = el("input", "decide-radio");
    radio.type = "radio";
    radio.id = optId;
    radio.name = `card-decide-${opId}-${contact.ticket}`;
    radio.value = option;
    radio.checked = option === choice;
    radios.push(radio);

    const dot = el("span", "decide-dot");
    dot.setAttribute("aria-hidden", "true");
    row.append(radio, dot, el("span", "decide-label", option));
    if (option === contact.recommended) row.append(el("span", "tag tag-recommended", "recommended"));
    radio.addEventListener("change", () => {
      if (radio.checked) select(option);
    });
    list.append(row);
  }
  box.append(list);
  updatePick(choice);
  return box;
}
