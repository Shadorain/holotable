// Plan → Archive: operations that were closed or aborted, out of the way of the open ones.
// The list comes from GET /api/archive; a report (GET /api/archive/report) is read-only.
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { clock, el, fmtMs, safeLink } from "./ui.js";

const OUTCOME = { landed: "Landed", abandoned: "Aborted", decision: "Decided", failed: "Failed" };
const OUTCOME_STATE = { landed: "landed", abandoned: "conflict", decision: "decision", failed: "conflict" };
const FINAL = { landed: "Landed", aborted: "Stopped by abort", "not-launched": "Never launched" };

const day = (iso) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

function outcomePill(outcome) {
  return el("span", `pill s-${OUTCOME_STATE[outcome] ?? "blocked"}`, OUTCOME[outcome] ?? outcome);
}



function listView(root, archive, ctx) {
  const box = el("section", "opdoc-sec");
  const head = el("div", "opdoc-head");
  head.append(el("h1", "opdoc-title", "Archive"), el("span", "set-note", "Operations that were closed or aborted. Read-only."));
  root.append(head);
  if (archive === null) {
    root.append(el("div", "empty-line", "Loading…"));
    return;
  }
  if (archive.error) {
    root.append(el("div", "set-err big", archive.error));
    return;
  }
  if (!archive.length) {
    root.append(el("div", "empty-line", "Nothing archived yet. Closing or aborting an operation puts its report here."));
    return;
  }
  const table = el("div", "ctable archive-table");
  const headRow = el("div", "ctable-row ctable-head");
  for (const h of ["Operation", "Outcome", "Closed", "Landed", ""]) headRow.append(el("span", "", h));
  table.append(headRow);
  for (const row of archive) {
    const r = el("div", "ctable-row");
    const name = el("button", "linkish", row.name);
    name.type = "button";
    name.dataset.key = `arch/${row.key}`;
    name.title = `Open the report for ${row.id}`;
    name.addEventListener("click", () => ctx.open(row.key));
    const o = el("span", "");
    o.append(outcomePill(row.outcome));
    r.append(name, o, el("span", "", day(row.closedAt)), el("span", "", `${row.counts.landed}/${row.counts.contacts}`), el("span", "mono dim", row.id));
    table.append(r);
  }
  box.append(table);
  root.append(box);
}

function reportView(root, entry, ctx) {
  const back = el("button", "btn small");
  back.type = "button";
  back.append(icon("chevron-down", { size: 13 }), document.createTextNode("All archived operations"));
  back.classList.add("back-btn");
  back.addEventListener("click", () => ctx.open(null));
  const bar = el("div", "back-bar");
  bar.append(back);
  root.append(bar);
  if (!entry || entry.loading) {
    root.append(el("div", "empty-line", "Loading the report…"));
    return;
  }
  if (entry.error) {
    root.append(el("div", "set-err big", entry.error));
    return;
  }
  const { report, history } = entry;
  const head = el("div", "opdoc-head");
  head.append(el("h1", "opdoc-title", report.name), el("span", "mono opdoc-id", report.id), outcomePill(report.outcome));
  root.append(head);
  root.append(
    el(
      "div",
      "set-note",
      `${day(report.createdAt)} → ${day(report.closedAt)} · ${fmtMs(report.durationMs)} · ${report.repo} on ${report.base}`,
    ),
  );

  const sum = el("section", "opdoc-sec");
  sum.append(el("div", "group-head", "Summary"));
  const kv = el("dl", "facts");
  const add = (k, v) => {
    const w = el("div", "");
    w.append(el("dt", "", k), el("dd", "", v));
    kv.append(w);
  };
  add("Contacts", String(report.counts.contacts));
  add("Landed", String(report.counts.landed));
  add("Launches", String(report.counts.launches));
  add("Land attempts", String(report.counts.landAttempts));
  add("Conflicts", String(report.counts.conflicts));
  add("Checklist", `${report.workflow.done}/${report.workflow.total}`);
  if (report.stats?.queueWaitAvgMs !== undefined) add("Queue wait (avg)", fmtMs(report.stats.queueWaitAvgMs));
  if (report.stats?.gateWaitMs !== undefined) add("Gate wait", fmtMs(report.stats.gateWaitMs));
  sum.append(kv);
  root.append(sum);

  if (report.brief) {
    const b = el("section", "opdoc-sec");
    b.append(el("div", "group-head", "Brief"), renderMarkdown(report.brief));
    root.append(b);
  }

  const cs = el("section", "opdoc-sec");
  cs.append(el("div", "group-head", "Contacts"));
  const table = el("div", "ctable report-table");
  const headRow = el("div", "ctable-row ctable-head");
  for (const h of ["Ticket", "Title", "Kind", "Result", "Links"]) headRow.append(el("span", "", h));
  table.append(headRow);
  for (const c of report.contacts) {
    const r = el("div", "ctable-row");
    const links = el("span", "chips");
    if (c.trackerUrl) links.append(safeLink(c.trackerUrl, "issue"));
    if (c.prUrl) links.append(safeLink(c.prUrl, "PR"));
    if (!c.trackerUrl && !c.prUrl) links.append(el("span", "dim", "—"));
    const result = c.final === "landed" && c.landedVia ? `Landed (${c.landedVia === "manual" ? "marked done" : c.landedVia})` : FINAL[c.final] ?? c.final;
    r.append(el("span", "mono", c.ticket), el("span", "ctable-title", c.title ?? "—"), el("span", "", c.kind), el("span", c.final === "landed" ? "ok-text" : "dim", result), links);
    table.append(r);
  }
  cs.append(table);
  root.append(cs);

  const hs = el("details", "opdoc-sec fold");
  const sumEl = el("summary", "group-head");
  sumEl.append(el("span", "", `History (${history.length})`));
  hs.append(sumEl);
  const ol = el("ol", "timeline-list");
  for (const h of history) {
    const li = el("li", h.cls);
    li.append(el("time", "", `${day(h.at)} ${clock(h.at)}`), el("span", `actor a-${h.actor}`, h.actor === "operator" ? "you" : h.actor), el("span", "", h.text));
    ol.append(li);
  }
  hs.append(ol);
  root.append(hs);
}

export function renderArchive(root, archive, selected, ctx) {
  root.replaceChildren();
  if (selected) reportView(root, selected, ctx);
  else listView(root, archive, ctx);
}
