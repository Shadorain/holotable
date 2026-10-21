import { clock, dateTime, el, errorText, fetchJson, fmtMs } from "./ui.js";
import { buildReviewPrompt } from "./intel-review.js";
import { operationDocket, fleetDocket } from "./intel-brief.js";

const duration = n => n == null ? "Unknown" : n === 0 ? "0s" : fmtMs(n);
const money = n => n == null ? "Unknown" : n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
// Counts are whole numbers; averages and rates keep at most one decimal; shares are whole percents.
const number = n => n == null ? "Unknown" : Math.round(n).toLocaleString();
const decimal = n => n == null ? "Unknown" : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const percent = r => `${Math.round(r * 100)}%`;
const plural = (n, word) => `${number(n)} ${word}${n === 1 ? "" : "s"}`;
const perHour = n => n == null ? "—" : `${decimal(n)}/h`;
// Table cells: a zero or absent duration reads as a dash, not "0s".
const msCell = n => n ? duration(n) : "—";
const sample = d => d.n ? `${duration(d.medianMs)} median · ${d.n} measured` : "None measured";
const date = value => new Date(value).toLocaleString();
const shortDate = at => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const opIdOf = source => source.startsWith("op:") ? source.slice(3) : "";
const sum = values => values.reduce((a, v) => a + (v ?? 0), 0);

function svgEl(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
function severityBadge(s) {
  const label = { critical: "ACTION", warning: "WATCH", watch: "WATCH", coverage: "COVERAGE" }[s] ?? s.toUpperCase();
  return el("span", `ia-badge ia-${s}`, label);
}
/** A contact's chip: opens it on the Board, or plain text where the Board cannot show it (archives). */
function ticketChip(ticket, open, opId, text = ticket) {
  if (!opId) return el("span", "ia-chip is-static", text);
  const chip = el("button", "ia-chip", text);
  chip.type = "button";
  chip.title = `Open ${ticket} on the board`;
  chip.addEventListener("click", () => open(`board:${opId}:${ticket}`));
  return chip;
}
function fixCard(fix, open, opId) {
  // Board and map links need a live operation; an archive's fixes keep their commands and notes.
  if (fix.kind === "link" && !opId) return null;
  const row = el("div", "ia-fix");
  const label = el("span", "ia-fix-label", fix.label);
  row.append(label);
  if (fix.kind === "cmd") {
    const cmd = el("button", "ia-cmd", fix.text);
    cmd.type = "button";
    cmd.title = "Copy command";
    cmd.addEventListener("click", () => {
      navigator.clipboard?.writeText(fix.text).then(
        () => { cmd.textContent = "Copied"; setTimeout(() => { cmd.textContent = fix.text; }, 1500); },
        () => { cmd.textContent = "Copy failed — select and copy manually"; },
      );
    });
    row.append(cmd);
  } else if (fix.kind === "link") {
    const link = el("button", "btn small", "Open on board →");
    link.type = "button";
    link.addEventListener("click", () => open(fix.text));
    row.append(link);
  } else {
    row.append(el("p", "intel-muted ia-note", fix.text));
  }
  return row;
}
/** "~2.3h · $4.10 at stake", or "" when the case measured no stake. */
function stakeText(impact) {
  const parts = [];
  if (impact?.ms > 0) parts.push(`~${duration(impact.ms)}`);
  if (impact?.usd > 0) parts.push(money(impact.usd));
  return parts.length ? `${parts.join(" · ")} at stake` : "";
}
function caseCard(c, open, opId) {
  const card = el("article", `ia-case ia-${c.severity}`);
  const head = el("div", "ia-case-head");
  head.append(severityBadge(c.severity), el("h3", "", c.title));
  const stake = stakeText(c.impact);
  if (stake) head.append(el("span", "ia-stake", stake));
  card.append(head, el("p", "ia-stats", c.stats), el("p", "intel-muted", c.detail));
  if (c.culprits?.length) {
    const chips = el("div", "ia-chips");
    chips.append(el("span", "ia-chips-label", "Worst offenders"));
    for (const ticket of c.culprits.slice(0, 3)) chips.append(ticketChip(ticket, open, opId));
    card.append(chips);
  }
  const fixes = el("div", "ia-fixes");
  for (const fix of c.fixes ?? []) {
    const row = fixCard(fix, open, opId);
    if (row) fixes.append(row);
  }
  if (fixes.childElementCount) card.append(fixes);
  return card;
}
function docketSection(cases, open, opId) {
  const section = el("section", "ia-docket");
  const head = el("div", "ia-docket-head");
  const ranked = cases.some(c => c.impact);
  head.append(el("h2", "intel-section-title", "Internal affairs"), el("span", "intel-muted", `${cases.length} open finding${cases.length === 1 ? "" : "s"}${ranked ? " · ranked by what each puts at stake" : ""}`));
  section.append(head);
  if (!cases.length) {
    section.append(el("p", "intel-muted", "No findings above threshold. Cases appear here when relaunches, failed checks, reviews, conflicts or waits cross a rule threshold; small samples limit conclusions."));
    return section;
  }
  const list = el("ol", "ia-list");
  for (const c of cases) {
    const item = el("li");
    item.append(caseCard(c, open, opId));
    list.append(item);
  }
  section.append(list);
  return section;
}
// Compact phase ledger: one row per phase with time, spend and tokens — the "big detail"
// that used to live inside three separate folded tables.
function phaseLedger(e) {
  const phases = new Set([...Object.keys(e.phaseMs), ...Object.keys(e.usage.byPhase ?? {})]);
  const totalMs = Object.values(e.phaseMs).reduce((a, b) => a + b, 0);
  const totalCost = Object.values(e.usage.byPhase ?? {}).reduce((a, v) => a + (v.costUsd ?? 0), 0);
  const rows = [...phases].map(phase => ({
    phase,
    ms: e.phaseMs[phase] ?? 0,
    cost: e.usage.byPhase?.[phase]?.costUsd ?? 0,
    tokens: e.usage.byPhase?.[phase]?.tokens ?? 0,
  })).sort((a, b) => b.ms - a.ms);
  if (!rows.length) return null;
  const table = el("table", "intel-metric-table ia-ledger");
  const head = el("tr");
  for (const col of ["Phase", "Time", "Time share", "Spend", "Spend share", "Tokens"]) head.append(el("th", "", col));
  const thead = el("thead"); thead.append(head); table.append(thead);
  const body = el("tbody");
  for (const r of rows) {
    const row = el("tr");
    const bar = el("div", "ia-bar");
    const fill = el("div", "ia-bar-fill");
    fill.style.width = `${totalMs ? Math.min(100, r.ms / totalMs * 100) : 0}%`;
    bar.append(fill);
    const timeCell = el("td", "ia-bar-cell");
    timeCell.append(bar, el("span", "", duration(r.ms)));
    row.append(
      el("td", "", r.phase),
      timeCell,
      el("td", "", totalMs ? percent(r.ms / totalMs) : "—"),
      el("td", "", r.cost ? money(r.cost) : "—"),
      el("td", "", totalCost && r.cost ? percent(r.cost / totalCost) : "—"),
      el("td", "", r.tokens ? number(r.tokens) : "—"),
    );
    body.append(row);
  }
  table.append(body);
  const box = el("section", "intel-panel ia-ledger");
  box.append(el("h3", "intel-section-title", "Phase ledger"));
  box.append(tableContainer(table, "Phase ledger: time, spend and tokens"));
  if (e.usage.partial) box.append(el("p", "intel-muted", "Spend is a session-associated estimate with partial coverage; phase attribution assigns each usage-sample delta to the phase active when the sample arrived."));
  return box;
}
const queryFor = value => {
  const colon = value.indexOf(":");
  return new URLSearchParams([[value.slice(0, colon), value.slice(colon + 1)]]).toString();
};
/** Rows are [label, value, note?, valueClass?]. */
function facts(rows, gridCls = "") {
  const grid = el("dl", `intel-facts ${gridCls}`.trim());
  for (const [label, value, note, cls] of rows) {
    const item = el("div");
    item.append(el("dt", "", label), el("dd", cls ?? "", String(value)));
    if (note) item.append(el("p", "", note));
    grid.append(item);
  }
  return grid;
}
function headline(label, value, note) {
  const card = el("dl", "intel-headline");
  card.append(el("dt", "", label), el("dd", "", value), el("p", "", note));
  return card;
}
/**
 * Four headline cards. Each slot shows its current question when the payload answers it, else the older
 * card it replaced (archives evaluated before the field existed); replaced cards stay below as totals.
 */
function headlineRow(current, legacy, label) {
  const heads = el("section", "intel-headlines");
  heads.setAttribute("aria-label", label);
  heads.append(...current.map((card, i) => headline(...(card ?? legacy[i]))));
  const replaced = legacy.filter((_, i) => current[i]);
  return replaced.length ? [heads, facts(replaced, "intel-totals")] : [heads];
}
function panel(title, note, cls = "") {
  const section = el("section", `intel-panel ${cls}`.trim());
  section.append(el("h3", "intel-section-title", title));
  if (note) section.append(el("p", "intel-muted intel-note", note));
  return section;
}
const emptyNote = text => el("p", "intel-muted intel-empty-note", text);
/** One horizontal bar of `parts` ({label, value, text, cls}) scaled so `scale` fills it; unknown or zero parts draw nothing. */
function stackBar(parts, scale, label) {
  const bar = el("div", "intel-stack");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${label}: ${parts.map(p => `${p.label} ${p.text}`).join(", ")}`);
  for (const p of parts) {
    if (!(p.value > 0) || !(scale > 0)) continue;
    const segment = el("span", p.cls);
    segment.style.width = `${p.value / scale * 100}%`;
    segment.title = `${p.label}: ${p.text}`;
    bar.append(segment);
  }
  return bar;
}
function legend(parts) {
  const list = el("ul", "intel-legend");
  for (const p of parts) {
    const item = el("li", p.legendCls ?? "");
    item.append(el("span", `intel-swatch ${p.cls}`), el("span", "", p.label), el("strong", "", p.text));
    list.append(item);
  }
  return list;
}
function tableContainer(table, label) {
  const container = el("div", "intel-table-scroll");
  container.tabIndex = 0;
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", label);
  container.append(table);
  return container;
}

const WAIT_KINDS = [
  ["plan-approval", "Plan approval"], ["gate", "Pause gate"], ["decision", "Decision"], ["question", "Question"],
  ["land", "Land"], ["launch", "Launch"], ["resume", "Resume"],
];
/** Where contact time went: missions working vs waits the operator or automation ended, then each wait kind. */
function timeSection(w) {
  const section = panel("Where time goes", "Contact time summed across contacts. A contact is in at most one wait at a time; mission time is launched, live time outside any wait.");
  const parts = [
    { label: "Missions working", value: w.missionMs, cls: "intel-c-mission" },
    { label: "Waited on you", value: w.operatorMs, cls: "intel-c-operator" },
    { label: "Resolved by automation", value: w.automationMs, cls: "intel-c-automation" },
    { label: "Waiting now", value: w.pendingMs, cls: "intel-c-pending" },
  ].map(p => ({ ...p, text: duration(p.value) }));
  const total = sum(parts.map(p => p.value));
  if (!total) {
    section.append(emptyNote("No contact time yet. Fills in once contacts are queued or launched: launch, plan approval, Pause gate, decision, question, Continue and Land waits are timed here."));
    return section;
  }
  section.append(stackBar(parts, total, "Contact time"), legend(parts));
  const kinds = WAIT_KINDS
    .map(([kind, label]) => ({ label, t: w.byKind[kind] }))
    .filter(({ t }) => t && t.waits + t.operatorMs + t.automationMs + t.pendingMs > 0);
  if (!kinds.length) {
    section.append(emptyNote("Nothing has waited on anyone yet. Each wait kind gets a bar here once work waits on a launch, plan approval, Pause gate, decision, question, Continue or Land."));
    return section;
  }
  const scale = Math.max(...kinds.map(({ t }) => t.operatorMs + t.automationMs + t.pendingMs));
  const list = el("div", "intel-kinds");
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", "Waits by kind");
  for (const { label, t } of kinds) {
    const kindParts = [
      { label: "On you", value: t.operatorMs, cls: "intel-c-operator" },
      { label: "Automation", value: t.automationMs, cls: "intel-c-automation" },
      { label: "Waiting now", value: t.pendingMs, cls: "intel-c-pending" },
    ].map(p => ({ ...p, text: duration(p.value) }));
    const spent = kindParts.filter(p => p.value > 0).map(p => `${p.text} ${p.label.toLowerCase()}`);
    const row = el("div", "intel-kind");
    row.setAttribute("role", "listitem");
    row.append(
      el("span", "intel-kind-label", label),
      stackBar(kindParts, scale, label),
      el("span", "intel-kind-text", [...spent, plural(t.waits, "wait")].join(" · ")),
    );
    list.append(row);
  }
  section.append(list);
  return section;
}

const TREND_ROWS = [
  ["launches", "Launches", "intel-c-launch"], ["deliveries", "Deliveries", "intel-c-deliver"],
  ["conflicts", "Conflicts", "intel-c-conflict"], ["reviewFailures", "Review failures", "intel-c-review"],
];
function bucketLabel(at, bucketMs) {
  if (bucketMs < 86_400_000) return `${shortDate(at)} ${clock(at)}`;
  if (bucketMs < 604_800_000) return shortDate(at);
  return `Week of ${shortDate(at)}`;
}
/** One row of bars, one per bucket; null values (no denominator) draw no bar. Each bucket's title explains it. */
function sparkBars(values, max, titles, cls, label) {
  const svg = svgEl("svg", { viewBox: `0 0 ${values.length} 100`, preserveAspectRatio: "none", class: `intel-spark ${cls}`, role: "img", "aria-label": label });
  svg.append(svgEl("line", { x1: 0, x2: values.length, y1: 99.5, y2: 99.5, class: "intel-spark-base", "vector-effect": "non-scaling-stroke" }));
  values.forEach((value, i) => {
    const slot = svgEl("g", {});
    const title = svgEl("title", {});
    title.textContent = titles[i];
    // A full-height transparent slot so even empty buckets explain themselves on hover.
    slot.append(title, svgEl("rect", { x: i, width: 1, y: 0, height: 100, class: "intel-spark-hit" }));
    if (value > 0 && max > 0) {
      const h = Math.max(value / max * 100, 6);
      slot.append(svgEl("rect", { x: i + 0.15, width: 0.7, y: 100 - h, height: h, class: "intel-spark-bar" }));
    }
    svg.append(slot);
  });
  return svg;
}
function trendRow(label, total, svg) {
  const row = el("div", "intel-trend");
  const name = el("div", "intel-trend-label");
  name.append(el("span", "", label), el("strong", "", total));
  row.append(name, svg);
  return row;
}
function trendSection(series) {
  const { buckets, bucketMs } = series;
  const grain = { 3_600_000: "Hourly", 86_400_000: "Daily" }[bucketMs] ?? "Weekly";
  const section = panel("Trends", `${grain} buckets since the operation was created${series.truncated ? "; the oldest beyond 168 weeks are dropped" : ""}. Hover a bar for its bucket.`);
  const counts = TREND_ROWS.map(([key]) => sum(buckets.map(b => b[key])));
  if (!buckets.length || !sum(counts)) {
    section.append(emptyNote("No launches, deliveries, conflicts or review failures yet. Fills in as missions launch, land and report reviews."));
    return section;
  }
  const labels = buckets.map(b => bucketLabel(b.at, bucketMs));
  const chart = el("div", "intel-trends");
  // Bars keep a bucket-sized width: a young operation's few buckets stay narrow instead of filling the row.
  chart.style.setProperty("--buckets", buckets.length);
  TREND_ROWS.forEach(([key, label, cls], row) => {
    const values = buckets.map(b => b[key]);
    const titles = values.map((v, i) => `${labels[i]} · ${number(v)} ${label.toLowerCase()}`);
    chart.append(trendRow(label, number(counts[row]), sparkBars(values, Math.max(...values), titles, cls, `${label} per bucket: ${number(counts[row])} in total, at most ${number(Math.max(...values))} in one bucket`)));
  });
  const attempts = sum(buckets.map(b => b.landAttempts));
  const rates = buckets.map(b => b.landAttempts ? b.conflicts / b.landAttempts : null);
  const rateTitles = buckets.map((b, i) => b.landAttempts ? `${labels[i]} · ${b.conflicts} of ${plural(b.landAttempts, "land attempt")} conflicted (${percent(rates[i])})` : `${labels[i]} · no land attempts`);
  const rateText = attempts ? percent(counts[2] / attempts) : "—";
  chart.append(trendRow("Conflict rate", rateText, sparkBars(rates, 1, rateTitles, "intel-c-rate", `Conflict rate per bucket: ${rateText} overall`)));
  const axis = el("div", "intel-axis");
  axis.setAttribute("aria-hidden", "true");
  // First and last bucket; a middle tick only once there are enough buckets to leave it room.
  const ticks = labels.length > 1 ? [labels[0], labels.at(-1)] : labels;
  if (labels.length >= 6) ticks.splice(1, 0, labels[Math.floor(labels.length / 2)]);
  for (const tick of ticks) axis.append(el("span", "", tick));
  chart.append(axis);
  section.append(chart);
  return section;
}

const OUTCOME_RANK = { open: 0, landed: 1, abandoned: 2 };
/** Sortable contact measures; `value` is null when the contact has none (sorted last either way). */
const CONTACT_SORTS = [
  { key: "lead", label: "Lead", title: "Queued → landed", value: c => c.leadMs },
  { key: "active", label: "Active", title: "Launched and live", value: c => c.activeMs },
  { key: "blocked", label: "Blocked", title: "Blocked before and after launch", value: c => c.blockedMs.beforeLaunch + c.blockedMs.afterLaunch },
  { key: "wait", label: "On you", title: "Time waiting on you, closed and still open", value: c => c.waitMs.operator + c.waitMs.pending },
  { key: "review", label: "Reviews", title: "Completed review rounds", value: c => c.review?.rounds ?? null },
  { key: "spend", label: "Spend", title: "Contact-attributed known spend", value: c => c.spend.costUsd },
  { key: "outcome", label: "Outcome", title: "Open, landed or abandoned", value: c => OUTCOME_RANK[c.outcome] },
];
/** Contacts ordered by a CONTACT_SORTS key; unknown values last, ties in declaration order. No key keeps declaration order. */
export function sortContacts(contacts, key, dir) {
  const sort = CONTACT_SORTS.find(s => s.key === key);
  if (!sort) return contacts.slice();
  const keyed = contacts.map((contact, index) => ({ contact, index, value: sort.value(contact) }));
  keyed.sort((a, b) => {
    if (a.value == null && b.value == null) return a.index - b.index;
    if (a.value == null) return 1;
    if (b.value == null) return -1;
    return (dir === "asc" ? a.value - b.value : b.value - a.value) || a.index - b.index;
  });
  return keyed.map(k => k.contact);
}
function outcomeText(c) {
  if (c.outcome === "landed") return "Landed";
  if (c.outcome === "abandoned") return `Abandoned · ${c.state}`;
  return `Open · ${c.state}`;
}
function contactCells(c) {
  const blocked = c.blockedMs.beforeLaunch + c.blockedMs.afterLaunch;
  let spend = c.spend.costUsd == null ? "—" : money(c.spend.costUsd);
  if (c.spend.costUsd != null && !c.spend.complete) spend += "*";
  return {
    lead: c.leadMs == null ? "—" : duration(c.leadMs),
    active: msCell(c.activeMs),
    blocked: msCell(blocked),
    wait: msCell(c.waitMs.operator + c.waitMs.pending),
    review: c.review ? number(c.review.rounds) : "—",
    spend,
  };
}
function contactFacts(c) {
  const when = [["Queued", c.queuedAt], ["Launched", c.launchedAt], ["Landed", c.landedAt], ["Ended", c.endedAt]]
    .filter(([, at]) => at != null).map(([label, at]) => `${label} ${dateTime(at)}`);
  const blockers = Object.entries(c.blockedMs.by).sort(([, a], [, b]) => b - a).slice(0, 3).map(([ticket, ms]) => `${ticket} ${duration(ms)}`);
  const r = c.relaunches;
  const relaunchBy = [[r.operator, "by you"], [r.recovery, "by Recovery"], [r.auto, "by auto mode"], [r.other, "other"]].filter(([n]) => n).map(([n, who]) => `${n} ${who}`);
  const cells = contactCells(c);
  const spans = pairs => pairs.filter(([ms]) => ms).map(([ms, what]) => `${duration(ms)} ${what}`).join(" · ") || "None";
  const rows = [
    ["Kind · phase", [c.kind, c.phase, c.hold && `hold ${c.hold}`].filter(Boolean).join(" · ")],
    ["Timeline", when.join(" · ") || "Not queued yet"],
    ["Active", cells.active, "", "intel-narrow-only"],
    ["Blocked", spans([[c.blockedMs.beforeLaunch, "before launch"], [c.blockedMs.afterLaunch, "after launch"]]), blockers.length ? `By ${blockers.join(", ")} (overlapping)` : ""],
    ["Waits", spans([[c.waitMs.operator, "on you"], [c.waitMs.automation, "resolved by automation"], [c.waitMs.pending, "waiting now"]])],
    ["Review", c.review ? `${plural(c.review.rounds, "round")} · ${plural(c.review.findings, "finding")} · ${plural(c.review.failures, "failure")}` : "No producer measurements"],
    ["Relaunches", r.total ? `${number(r.total)}${relaunchBy.length ? ` (${relaunchBy.join(", ")})` : ""}` : "None", c.launchFailures ? plural(c.launchFailures, "failed launch") : ""],
    ["Conflicts", c.conflicts.landAttempts ? `${number(c.conflicts.count)} of ${plural(c.conflicts.landAttempts, "land attempt")}` : "No land attempts", c.conflicts.paths.join(", ")],
    ["Offline", msCell(c.offlineMs)],
    ["Spend", cells.spend, [c.spend.tokens != null && `${number(c.spend.tokens)} tokens`, c.spend.costUsd != null && !c.spend.complete && "partially priced"].filter(Boolean).join(" · ")],
  ];
  const list = el("dl", "intel-contact-facts");
  for (const [label, value, note, cls] of rows) {
    const item = el("div", cls ?? "");
    item.append(el("dt", "", label), el("dd", "", value));
    if (note) item.append(el("p", "", note));
    list.append(item);
  }
  return list;
}
/** Sortable per-contact table; rows open the contact on the Board. Narrow screens keep key columns and fold the rest into each row's details. */
function contactsSection(contacts, open, opId) {
  const section = panel("Contacts", opId ? "Select a row to open the contact on the Board; Details expands everything recorded for it." : "Archived operation: its contacts are no longer on the Board.");
  if (!contacts.length) {
    section.append(emptyNote("No contacts declared. A row appears for each contact added to the operation."));
    return section;
  }
  let sortKey = "";
  let sortDir = "desc";
  const expanded = new Set();
  const columns = [
    { key: "", label: "Contact" },
    ...CONTACT_SORTS.filter(s => s.key === "outcome"),
    ...CONTACT_SORTS.filter(s => s.key !== "outcome"),
  ];
  const extra = new Set(["active", "blocked", "wait", "review", "spend"]);
  const table = el("table", "intel-metric-table intel-contacts");
  const headRow = el("tr");
  const headers = new Map();
  for (const col of columns) {
    const th = el("th", extra.has(col.key) ? "intel-col-extra" : "");
    th.scope = "col";
    if (col.key) {
      const button = el("button", "intel-sort", col.label);
      button.type = "button";
      button.title = `Sort by ${col.title.toLowerCase()}`;
      button.addEventListener("click", () => {
        if (col.key !== sortKey) setSort(col.key, defaultDir(col.key));
        else setSort(col.key, sortDir === "desc" ? "asc" : "desc");
      });
      th.append(button);
      headers.set(col.key, th);
    } else th.textContent = col.label;
    headRow.append(th);
  }
  const detailsHead = el("th", "intel-expand-col");
  detailsHead.append(el("span", "intel-sr", "Details"));
  headRow.append(detailsHead);
  const thead = el("thead");
  thead.append(headRow);
  const body = el("tbody");
  table.append(thead, body);

  const select = el("select");
  select.append(new Option("Declared order", ""), ...CONTACT_SORTS.map(s => new Option(s.title, s.key)));
  select.addEventListener("change", () => setSort(select.value, defaultDir(select.value)));
  const selectLabel = el("label", "intel-sort-select");
  selectLabel.append(el("span", "", "Sort"), select);

  function defaultDir(key) {
    return key === "outcome" ? "asc" : "desc";
  }
  function setSort(key, dir) {
    sortKey = key;
    sortDir = dir;
    select.value = key;
    for (const [colKey, th] of headers) {
      if (colKey === sortKey) th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    }
    renderRows();
  }
  function renderRows() {
    body.replaceChildren();
    for (const c of sortContacts(contacts, sortKey, sortDir)) {
      const cells = contactCells(c);
      const row = el("tr", "intel-contact-row");
      const name = el("td", "intel-contact-name");
      if (opId) {
        row.classList.add("is-link");
        const link = el("button", "intel-ticket", c.ticket);
        link.type = "button";
        link.title = `Open ${c.ticket} on the board`;
        name.append(link);
        row.addEventListener("click", event => {
          if (!event.target.closest(".intel-expand")) open(`board:${opId}:${c.ticket}`);
        });
      } else name.append(el("span", "intel-ticket", c.ticket));
      row.append(name, el("td", "", outcomeText(c)));
      for (const col of columns.slice(2)) {
        const cell = el("td", extra.has(col.key) ? "intel-col-extra" : "", cells[col.key]);
        if (col.key === "wait" && c.waitMs.pending > 0) {
          cell.classList.add("intel-pending");
          cell.title = `${duration(c.waitMs.pending)} waiting on you now`;
        }
        row.append(cell);
      }
      const detail = el("tr", "intel-contact-detail");
      const detailCell = el("td");
      detailCell.colSpan = columns.length + 1;
      detail.append(detailCell);
      detail.hidden = !expanded.has(c.ticket);
      if (!detail.hidden) detailCell.append(contactFacts(c));
      const toggle = el("button", "intel-expand", "Details");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(!detail.hidden));
      toggle.setAttribute("aria-label", `Details for ${c.ticket}`);
      toggle.addEventListener("click", () => {
        detail.hidden = !detail.hidden;
        toggle.setAttribute("aria-expanded", String(!detail.hidden));
        if (detail.hidden) expanded.delete(c.ticket);
        else {
          expanded.add(c.ticket);
          if (!detailCell.childElementCount) detailCell.append(contactFacts(c));
        }
      });
      const toggleCell = el("td", "intel-expand-col");
      toggleCell.append(toggle);
      row.append(toggleCell);
      body.append(row, detail);
    }
  }
  renderRows();
  section.append(selectLabel, tableContainer(table, "Contacts"));
  if (contacts.some(c => c.spend.costUsd != null && !c.spend.complete)) section.append(el("p", "intel-muted intel-note", "* Spend partially priced: the contact has unpriced or missing usage."));
  return section;
}

/** Known spend by what it bought, with waste called out and coverage stated when not every contact is priced. */
function spendSection(s, knownCostUsd, partial, scope) {
  const section = panel("Spend", scope);
  if (knownCostUsd == null) {
    section.append(emptyNote("No usage cost recorded yet. Fills in once missions or decision panes report priced usage."));
    return section;
  }
  const parts = [
    { label: "Landed work", value: s.landedUsd, cls: "intel-c-landed" },
    { label: "Integration & decisions", value: s.supportUsd, cls: "intel-c-support" },
    { label: "Still open", value: s.openUsd, cls: "intel-c-open" },
    { label: "Abandoned", value: s.abandonedUsd, cls: "intel-c-abandoned", legendCls: s.abandonedUsd ? "intel-wasted" : "" },
    { label: "Decision panes", value: s.paneUsd, cls: "intel-c-panes", legendCls: s.paneUsd ? "intel-wasted" : "" },
  ].map(p => ({ ...p, text: money(p.value) }));
  const total = sum(parts.map(p => p.value));
  section.append(stackBar(parts, total, "Known spend by what it bought"), legend(parts));
  section.append(facts([
    ["Per landed contact", money(s.perLandedUsd), s.landedPriced ? `Landed work over ${plural(s.landedPriced, "priced landed contact")}` : "No priced landed contact yet"],
    ["Wasted", money(s.wastedUsd), s.wastedUsd && total ? `${percent(s.wastedUsd / total)} of the split above · abandoned contacts and decision panes` : "Abandoned contacts and decision panes", s.wastedUsd ? "intel-wasted" : ""],
    ["Known spend", money(knownCostUsd), partial ? "Partial estimate, not a bill" : "Observed estimate, not a bill"],
  ]));
  if (s.knownShare != null && s.knownShare < 1) {
    const priced = s.pricedShare != null ? `, ${percent(s.pricedShare)} of messages priced` : "";
    section.append(el("p", "intel-caveat", `Spend is fully known for ${percent(s.knownShare)} of launched contacts${priced}; read these figures as lower bounds.`));
  }
  return section;
}

const STALL_KINDS = [
  ["quota", "Quota holds"], ["rateLimit", "Rate limits"], ["otherProblem", "Other mission problems"],
  ["capacityWait", "Waiting for board capacity"], ["recoveryDeferral", "Recovery deferrals"], ["offline", "Offline sockets"],
];
function stallSection(st) {
  const section = panel("Stalls");
  const episodes = STALL_KINDS.filter(([key]) => st[key]).map(([key, label]) => ({ label, ...st[key] }));
  const r = st.launchRefusals;
  const refusals = [["memory pressure", r.memory], ["session cap", r.sessionCap], ["other refusals", r.refused], ["Recovery gave up", r.gaveUp]];
  const refused = sum(refusals.map(([, n]) => n));
  if (!episodes.some(s => s.episodes || s.ms) && !refused && !st.reviewFailures) {
    section.append(emptyNote("No stalls recorded. Quota holds, offline sockets, refused launches and review failures appear here."));
  } else {
    section.append(facts([
      ...episodes.map(s => [s.label, s.episodes ? duration(s.ms) : "None", s.episodes ? plural(s.episodes, "episode") : ""]),
      ["Launch refusals", refused ? number(refused) : "None", refusals.filter(([, n]) => n).map(([why, n]) => `${n} ${why}`).join(" · ")],
      ["Review failures", st.reviewFailures == null ? "Not measured" : number(st.reviewFailures), "May include provider-capacity failures"],
    ]));
  }
  if (st.caveat) section.append(el("p", "intel-muted intel-note", st.caveat));
  return section;
}
function conflictSection(c, attempts, open, opId) {
  const section = panel("Conflicts");
  if (!attempts.landAttempts) {
    section.append(emptyNote("No land attempts yet. The conflict rate and the most conflicting paths and contacts fill in as contacts land."));
    return section;
  }
  const rate = el("p", "intel-rate");
  rate.append(el("strong", "", percent(c.rate ?? attempts.conflicts / attempts.landAttempts)), el("span", "intel-muted", ` of land attempts conflicted · ${number(attempts.conflicts)} of ${plural(attempts.landAttempts, "attempt")}`));
  section.append(rate);
  if (!attempts.conflicts) return section;
  if (c.paths.length) {
    section.append(el("h4", "intel-subtitle", "Most conflicting paths"));
    const list = el("ul", "intel-paths");
    for (const p of c.paths) {
      const item = el("li");
      const chips = el("span", "ia-chips");
      for (const ticket of p.contacts) chips.append(ticketChip(ticket, open, opId));
      item.append(el("code", "", p.path), el("span", "intel-muted", plural(p.conflicts, "conflict")), chips);
      list.append(item);
    }
    section.append(list);
  }
  if (c.contacts.length) {
    section.append(el("h4", "intel-subtitle", "Most conflicting contacts"));
    const chips = el("div", "ia-chips");
    for (const t of c.contacts) chips.append(ticketChip(t.ticket, open, opId, `${t.ticket} · ${t.conflicts}/${t.landAttempts}`));
    section.append(chips);
  }
  const notes = [];
  if (c.unpathed) notes.push(`${plural(c.unpathed, "conflict")} recorded no paths.`);
  if (c.truncated) notes.push("More paths conflicted than are tracked; the list may miss some.");
  if (notes.length) section.append(el("p", "intel-muted intel-note", notes.join(" ")));
  return section;
}

function metricRows(list, render, share = false) {
  const table = el("table", "intel-metric-table");
  const head = el("tr");
  for (const col of ["Class", "Recorded", share ? "Recorded share" : "Rate", "Affected ops"]) head.append(el("th", "", col));
  const thead = el("thead"); thead.append(head); table.append(thead);
  const body = el("tbody");
  for (const m of list) {
    const row = el("tr");
    const basis = share ? m.unit === "ms" ? duration(m.denominator) : money(m.denominator) : number(m.denominator);
    row.append(el("td", "", m.label), el("td", "", render(m)), el("td", "", m.rate == null ? "—" : `${percent(m.rate)} of ${basis}`), el("td", "", String(m.operations)));
    body.append(row);
  }
  table.append(body);
  return tableContainer(table, share ? "Shares of recorded evidence" : "Recorded events and denominators");
}
function cohortRows(cohorts) {
  const table = el("table", "intel-metric-table");
  const head = el("tr");
  for (const col of ["Configuration", "Ops", "Delivered", "Known spend", "$/delivered", "Wait recorded"]) head.append(el("th", "", col));
  const thead = el("thead"); thead.append(head); table.append(thead);
  const body = el("tbody");
  for (const c of cohorts) {
    const row = el("tr");
    const per = c.delivered > 0 && c.knownCostUsd != null ? money(c.knownCostUsd / c.delivered) : "Unknown";
    row.append(el("td", "", c.key), el("td", "", String(c.operations)), el("td", "", String(c.delivered)), el("td", "", c.knownCostUsd == null ? "Unknown" : money(c.knownCostUsd) + (c.usagePartial ? "*" : "")), el("td", "", per), el("td", "", c.waitMs > 0 ? duration(c.waitMs) : "—"));
    body.append(row);
  }
  table.append(body);
  return tableContainer(table, "Configuration cohorts");
}
function rankedSection(title, list, render, share = false) {
  const section = el("section", "intel-ranking");
  section.append(el("h3", "intel-section-title", title));
  if (!list.length) {
    section.append(el("p", "intel-muted", "Nothing recorded yet. Fills in as evaluated operations record these classes; missing data is not a measured zero."));
    return section;
  }
  section.append(metricRows(list.slice(0, 3), render, share));
  if (list.length > 3) {
    const more = el("details", "intel-more");
    more.append(el("summary", "", `Show ${list.length - 3} more ${list.length === 4 ? "class" : "classes"}`));
    more.addEventListener("toggle", () => {
      if (more.open && more.children.length === 1) more.append(metricRows(list.slice(3), render, share));
    });
    section.append(more);
  }
  return section;
}
/** "80% of launched contacts fully priced", or "" when nothing launched. */
const knownShareNote = s => s.knownShare == null ? "" : `${percent(s.knownShare)} of launched contacts fully priced`;
function fleetHeadlines(t) {
  const a = t.activity, s = t.spend, w = t.operatorWait;
  const across = n => `across ${plural(n, "operation")}`;
  const current = [
    a && ["Deliveries per active hour", perHour(a.deliveriesPerActiveHour), `${number(a.delivered)} delivered in ${duration(a.activeMs)} active · ${across(a.operations)}`],
    s && ["Cost per landed contact", money(s.perLandedUsd), [knownShareNote(s), across(s.operations)].filter(Boolean).join(" · ")],
    w && ["Waiting on you now", w.pendingMs ? duration(w.pendingMs) : "None", `${duration(w.operatorMs)} waited on you in total · ${across(w.operations)}`],
    a && ["Active time", duration(a.activeMs), `${duration(a.idleMs)} idle · summed per operation, so concurrent operations add`],
  ];
  const legacy = [
    ["Delivered work", number(t.delivered), `${t.timed} timed contacts`],
    ["Operation spend", money(t.knownCostUsd), t.knownCostUsd == null ? "No usage cost recorded" : t.usagePartial ? "Partial estimate · includes decision panes" : "Observed estimate · includes decision panes"],
    ["Per delivered", money(t.costPerDelivered), "Includes unfinished operation work; excludes drafts"],
    ["Review rounds", number(t.reviews), t.repairRounds == null ? "No quality instrumentation recorded" : `${number(t.repairRounds)} accepted repairs · not external acceptance`],
  ];
  return headlineRow(current, legacy, "Fleet totals");
}
function rollupSection(rollup, open, opId) {
  const section = el("section", "intel-rollup");
  const t = rollup.totals;
  section.append(el("h2", "intel-section-title", "Fleet overview"));
  section.append(el("p", "intel-muted", `${rollup.sources.evaluated} evaluated sources · ${rollup.sources.open} open · ${rollup.sources.archived} archived · ${rollup.sources.missingEvaluation} without evaluation`));
  if (!rollup.sources.evaluated && !t.panes) {
    section.append(el("p", "intel-empty intel-muted", "No evaluated operations or pane spend recorded yet. Fills in once an operation launches missions or board panes report usage; missing history is not reconstructed."));
    return section;
  }
  if (rollup.sources.evaluated) {
    section.append(...fleetHeadlines(t), docketSection(fleetDocket(rollup, { duration, money, number }), open, opId));
    if (t.operatorWait) section.append(timeSection(t.operatorWait));
    if (t.spend) section.append(spendSection(t.spend, t.knownCostUsd, t.usagePartial, `Summed over ${plural(t.spend.operations, "operation")} that split spend; older archives count in known spend only.`));
  }
  if (t.panes) {
    const paneNote = `${number(t.panes.sessions)} draft/decision sessions · ${number(t.panes.tokens)} tokens${t.panes.partial ? " · partial coverage" : ""}`;
    section.append(facts(rollup.sources.evaluated ? [
      ["Board panes · subtotal", money(t.panes.costUsd), paneNote],
      ["Draft spend", money(t.drafts?.costUsd), t.drafts ? "Board-wide; excluded from operation spend and cost per delivery." : "No closed-draft usage recorded."],
    ] : [["Draft spend", money(t.drafts?.costUsd), `${paneNote} · No operation evidence recorded yet.`]]));
  }
  if (rollup.sources.evaluated) {
    const rankings = el("details", "intel-subsection");
    rankings.append(el("summary", "", "Ranked failure, wait, cost and phase classes"));
    rankings.addEventListener("toggle", () => {
      if (rankings.open && rankings.children.length === 1) {
        const grid = el("div", "intel-rankings");
        grid.append(
          rankedSection("Recorded failures & rework", rollup.failures, m => number(m.value)),
          rankedSection("Where recorded time waits", rollup.waits, m => duration(m.value), true),
          rankedSection("Attributed phase costs", rollup.costs, m => money(m.value), true),
          rankedSection("Recorded phase durations", rollup.phases, m => duration(m.value), true),
        );
        rankings.append(grid);
      }
    });
    section.append(rankings);
  }
  if (rollup.cohorts.length > 1) {
    const box = el("details", "intel-subsection");
    box.append(el("summary", "", "Configuration cohorts · descriptive, not controlled comparisons"), cohortRows(rollup.cohorts));
    section.append(box);
  }
  const diagnostics = el("details", "intel-subsection");
  diagnostics.append(el("summary", "", "Coverage, tokens & limitations"), facts([
    ["Mission input / output", t.tokens ? `${number(t.tokens.input)} / ${number(t.tokens.output)}` : "Unknown"],
    ["Mission cache read / write", t.tokens ? `${number(t.tokens.cacheRead)} / ${number(t.tokens.cacheWrite)}` : "Unknown"],
  ]), el("p", "intel-muted", rollup.caveats.join(" ")));
  section.append(diagnostics);
  return section;
}
function evidenceDetails(e) {
  const q = e.quality, u = e.usage;
  const box = el("details", "intel-subsection");
  box.append(el("summary", "", "Recorded evidence & coverage"));
  box.addEventListener("toggle", () => {
    if (box.open && box.children.length === 1) {
      box.append(facts([
        ["Queue → launch", sample(e.queue), "Median finished queue wait."],
        ["Queue → delivery", sample(e.lead), "End-to-end lead for delivered work."],
        ["Still queued", e.queued.n ? `${e.queued.n} · oldest ${duration(e.queued.maxMs)}` : "None"],
        ["Launched, not delivered", e.unfinished.n ? `${e.unfinished.n} · oldest ${duration(e.unfinished.maxMs)}` : "None"],
        ["Dependency wait", duration(e.dependencyWaitMs)], ["Gate wait", duration(e.gateWaitMs)],
        ["Offline / unreachable", duration(e.offlineMs)], ["Ready → landed", duration(e.deliveryReadyMs)],
        ["Launches / relaunches", `${e.attempts.launches} / ${e.attempts.relaunches}`],
        ["Recorded passes / fails", q ? `${number(q.recordedPassed)} / ${number(q.recordedFailed)}` : "No quality instrumentation"],
        ["Review rounds / failures", q ? `${number(q.completedRounds)} / ${number(q.reviewFailures)}` : "—"],
        ["Accepted repairs", q ? number(q.acceptedRepairs) : "—"],
        ["Latest actionable findings", q ? number(q.latestActionable) : "—"],
        ["Known spend / delivered", `${money(u.knownCostUsd)} / ${money(u.costPerDelivered)}`],
        ["Usage coverage", `${e.coverage.usageReported} / ${e.coverage.launched} launched · basis ${u.basis}`],
        ["Missing / unsupported", `${number(u.missingSources)} / ${number(u.unsupportedWorkers)}`],
        ["Reset observations", number(u.resets + e.coverage.counterResets)],
        ["Connectivity mean / peak", e.connectivity.mean == null ? "Unknown" : `${decimal(e.connectivity.mean)} / ${e.connectivity.peak} missions`],
        ["Configuration", e.config.value ? `${e.config.value.graph} / ${e.config.value.frontend} / ${e.config.value.maxWorkers} workers / ${e.config.value.mode}` : "Uninstrumented"],
      ]));
    }
  });
  return box;
}
function experiments() {
  const box = el("details", "intel-experiments");
  box.append(el("summary", "", "Controlled comparisons · optional"));
  box.append(el("p", "intel-muted", "Compare archived maxWorkers configurations with the offline command below. Declare paired workloads, the same repository/base, acceptance criteria and environment; choose the baseline explicitly. Include incomplete and failed runs. At least five complete comparable pairs are required; missing coverage or contradictory observed configurations prevent stronger comparisons. External outcomes remain operator-assessed."));
  box.append(el("pre", "", "holotable compare --manifest /path/to/comparison.json"));
  box.append(el("p", "intel-muted", "Each manifest declares v: 1, variable: maxWorkers, baseline: A or B, groups: {A: workerLimit, B: workerLimit}, and trials with archive, group, pair, repo, baseCommit, workload, acceptance, environment, externalOutcome (pass / fail / unassessed). Results are descriptive, not causal; Intel never schedules experiments or changes configuration."));
  return box;
}
// throughputPerHour extrapolates from operation lifetime; under an hour that reads as an inflated rate,
// so short operations show the elapsed window instead.
function throughputNote(e) {
  if (e.throughputPerHour == null) return "No operation time recorded";
  if (!e.deliveredWork) return "None delivered yet";
  const elapsedMs = e.deliveredWork * 3_600_000 / e.throughputPerHour;
  if (elapsedMs < 3_600_000) return `In ${duration(elapsedMs)} since the operation was created`;
  return `${decimal(e.throughputPerHour)}/h over ${duration(elapsedMs)} since creation`;
}
/** The wall-time rate beside deliveries per active hour, with the same under-an-hour window as throughputNote. */
function wallTimeNote(e) {
  if (e.throughputPerHour == null) return "no wall time recorded";
  const elapsedMs = e.deliveredWork ? e.deliveredWork * 3_600_000 / e.throughputPerHour : null;
  if (elapsedMs != null && elapsedMs < 3_600_000) return `${duration(elapsedMs)} of wall time`;
  return `${perHour(e.throughputPerHour)} over wall time`;
}
function operationHeadlines(e, closed) {
  const a = e.activity, s = e.usage.spend, w = e.operatorWait;
  const waiting = e.contacts?.filter(c => c.waitMs.pending > 0).length;
  let waitNote = `${duration(w?.operatorMs)} waited on you in total`;
  if (closed) waitNote = `Nothing waits once closed · ${waitNote}`;
  else if (waiting) waitNote = `${plural(waiting, "contact")} waiting · ${waitNote}`;
  const elapsed = a ? a.activeMs + a.idleMs : 0;
  const current = [
    a && ["Deliveries per active hour", perHour(a.deliveriesPerActiveHour), `${number(e.deliveredWork)} delivered in ${duration(a.activeMs)} active · ${wallTimeNote(e)}`],
    s && ["Cost per landed contact", money(s.perLandedUsd), e.usage.knownCostUsd == null ? "No usage cost recorded" : [s.landedPriced ? plural(s.landedPriced, "priced landed contact") : "No priced landed contact yet", knownShareNote(s)].filter(Boolean).join(" · ")],
    w && ["Waiting on you now", w.pendingMs ? duration(w.pendingMs) : "None", waitNote],
    a && ["Active time", duration(a.activeMs), elapsed ? `${duration(a.idleMs)} idle · active ${percent(a.activeMs / elapsed)} of elapsed` : "Nothing queued or live yet"],
  ];
  const legacy = [
    ["Delivered work", number(e.deliveredWork), throughputNote(e)],
    ["Known spend", money(e.usage.knownCostUsd), e.usage.knownCostUsd == null ? "No usage cost recorded" : e.usage.partial ? "Partial coverage" : e.usage.coordinatorSessionAssociated ? "Session-associated estimate" : "Observed estimate"],
    ["Median launch → land", duration(e.delivery.medianMs), `${e.delivery.n} delivered measurements`],
    ["Recorded check failures", number(e.quality?.recordedFailed), e.quality ? "Producer-reported, not external judgment" : "No quality instrumentation recorded"],
  ];
  return headlineRow(current, legacy, "At a glance");
}
function renderSnapshot(root, snapshot, open, opId, auto) {
  root.replaceChildren();
  const title = el("div", "intel-title");
  title.append(el("h2", "", snapshot.name), el("span", "intel-badge", snapshot.closedAt ? "Frozen archive" : "Open operation · snapshot"));
  root.append(title);
  const e = snapshot.evaluation;
  if (!e) {
    root.append(el("p", "intel-empty intel-muted", "No evaluation stored for this archive (closed before Intel recorded evidence). Stored reports are not recalculated; operations closed now keep their close-time evaluation."), experiments());
    return;
  }
  root.append(...operationHeadlines(e, Boolean(snapshot.closedAt)), docketSection(operationDocket(e, { duration, money, number, opId, auto: snapshot.closedAt ? null : auto }), open, opId));
  // Panels below need fields older archived evaluations lack; each shows only when its data exists.
  if (!e.operatorWait && !e.series && !e.contacts && !e.usage.spend && !e.stalls && !e.conflicts) {
    root.append(el("p", "intel-muted intel-note intel-legacy", "Evaluated before per-contact, wait, trend, spend, stall and conflict breakdowns were recorded; stored evaluations are not recalculated, so only these measures are available."));
  }
  if (e.operatorWait) root.append(timeSection(e.operatorWait));
  if (e.series) root.append(trendSection(e.series));
  if (e.contacts) root.append(contactsSection(e.contacts, open, opId));
  if (e.usage.spend) root.append(spendSection(e.usage.spend, e.usage.knownCostUsd, e.usage.partial));
  if (e.stalls || e.conflicts) {
    const pair = el("div", "intel-pair");
    if (e.stalls) pair.append(stallSection(e.stalls));
    if (e.conflicts) pair.append(conflictSection(e.conflicts, e.attempts, open, opId));
    root.append(pair);
  }
  const ledger = phaseLedger(e);
  if (ledger) root.append(ledger);
  root.append(evidenceDetails(e), experiments());
}
function reviewHelp() {
  const box = el("details", "intel-experiments");
  box.id = "intelReviewHelp";
  const code = el("code", "", "omp --model YOUR_SMALL_MODEL --no-tools --no-extensions --no-skills --no-rules --no-title --no-session --max-time 2m -p @holotable-intel-review.txt");
  const pre = el("pre");
  pre.append(code);
  box.append(
    el("summary", "", "Optional small-model review · manual"),
    el("p", "intel-muted", "Export the current scope, inspect the downloaded evidence, then choose a small model explicitly. Exporting and refreshing never call a model. The prompt contains aggregate measurements, coverage limits and evidence references—not transcripts or access tokens."),
    el("p", "intel-muted", "From the download directory, replace YOUR_SMALL_MODEL with your model selector:"),
    pre,
    el("p", "intel-muted", "This produces advisory interpretation, not an independent code check or permission to change missions. Two minutes is a wall-time limit, not a price cap. Model charges belong to the separate OMP session; they are not automatically added to this operation’s spend."),
  );
  return box;
}

/**
 * The Intel view's body inside `root`. The board owns what it shows (header picker → source, sub-tabs → scope)
 * and calls show(); evidence loads only when that pair changes, on Refresh, or after invalidate().
 * `sources(archives)` hands the archive list to the picker; `sourceGone()` asks the board to drop a vanished archive;
 * `openBoard({ plan, op, ticket })` follows a finding's link; `autoOf(opId)` is that open operation's auto settings, if loaded.
 */
export function createIntel(root, { api, sources, sourceGone, openBoard, autoOf = () => null }) {
  const intro = el("div", "intel-intro");
  intro.append(
    el("p", "intel-eyebrow", "OPERATION INTELLIGENCE"),
    el("h1", "", "What’s helping. What’s holding work up."),
    el("p", "intel-muted", "Delivery, rework and resource use from recorded evidence. Read-only: no scores, no automatic changes, no model calls."),
  );
  const refresh = el("button", "btn", "Refresh snapshot");
  refresh.type = "button";
  const exportReview = el("button", "btn", "Export review prompt");
  exportReview.type = "button";
  exportReview.disabled = true;
  exportReview.title = "Downloads a bounded evidence prompt only; never launches a model";
  exportReview.setAttribute("aria-details", "intelReviewHelp");
  const snapshotTime = el("p", "intel-muted", "Loads only when opened or refreshed. No background updates.");
  snapshotTime.setAttribute("role", "status");
  const toolbar = el("section", "intel-toolbar");
  toolbar.setAttribute("aria-label", "Snapshot");
  toolbar.append(refresh, exportReview, snapshotTime);
  const status = el("div");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const rollupBox = el("section");
  rollupBox.setAttribute("aria-label", "Fleet overview");
  const dashboard = el("div");
  root.replaceChildren(intro, toolbar, status, rollupBox, dashboard, reviewHelp(), el("footer", "intel-footer", "Self-checks, reviews and landing are evidence of process—not externally verified correctness. Known cost is an estimate, not a bill."));

  let scope = null;
  let source = "";
  let sourcesLoaded = false;
  let notice = ""; // shown by the next load: it explains why the source changed
  let request = null;
  let generation = 0;
  let reviewEvidence = null;
  const get = async (path, signal) => fetchJson(await api(path, { signal }));
  const open = text => {
    const [kind, op, ticket] = text.split(":");
    openBoard({ plan: kind === "map", op, ticket });
  };
  function message(text, error = false) {
    status.replaceChildren(el("p", error ? "intel-error" : "intel-muted", text));
  }

  async function load() {
    request?.abort();
    reviewEvidence = null;
    exportReview.disabled = true;
    request = new AbortController();
    const signal = request.signal, current = ++generation;
    const fleet = scope === "fleet";
    rollupBox.hidden = !fleet;
    dashboard.hidden = fleet;
    const box = fleet ? rollupBox : dashboard;
    box.replaceChildren();
    box.setAttribute("aria-busy", "true");
    refresh.disabled = true;
    snapshotTime.textContent = "Loading evidence…";
    message("Reading stored evidence…");
    let note = notice;
    notice = "";
    try {
      if (!sourcesLoaded) {
        try {
          const list = await get("/api/intel/sources", signal);
          if (current !== generation) return;
          sourcesLoaded = true;
          sources(list.archives);
          if (source.startsWith("archive:") && !list.archives.some(a => `archive:${a.key}` === source)) {
            notice = "The previous source is no longer available.";
            sourceGone(); // the board shows its selected operation instead, which starts the next load
            return;
          }
        } catch (error) {
          if (signal.aborted) return;
          note = `Source list unavailable: ${errorText(error)}. Refresh to retry.`;
        }
      }
      if (fleet) {
        const rollup = await get("/api/intel/rollup", signal);
        if (current !== generation) return;
        box.replaceChildren(rollupSection(rollup, open, opIdOf(source)));
        reviewEvidence = { scope: "fleet", rollup };
        snapshotTime.textContent = `Fleet evidence as of ${date(rollup.generatedAt)}. Refresh is manual.`;
      } else if (source) {
        const snapshot = await get(`/api/intel?${queryFor(source)}`, signal);
        if (current !== generation) return;
        renderSnapshot(dashboard, snapshot, open, opIdOf(source), autoOf(opIdOf(source)));
        reviewEvidence = snapshot.evaluation ? { scope: "operation", source, snapshot } : null;
        snapshotTime.textContent = `${snapshot.closedAt ? "Frozen at close" : "Evidence as of"} ${date(snapshot.evaluation?.asOf ?? snapshot.closedAt ?? Date.now())}. No background updates.`;
      } else {
        note = "No operations yet. Create one on the board; its evidence appears here once missions launch. Fleet overview can still show recorded draft spend.";
        snapshotTime.textContent = "No operation selected.";
      }
      message(note);
    } catch (error) {
      if (!signal.aborted && current === generation) {
        message(errorText(error), true);
        snapshotTime.textContent = `${fleet ? "Fleet overview" : "Operation snapshot"} unavailable. Refresh to retry or switch scope.`;
      }
    } finally {
      if (current === generation) {
        refresh.disabled = false;
        exportReview.disabled = !reviewEvidence;
        box.setAttribute("aria-busy", "false");
      }
    }
  }

  refresh.addEventListener("click", () => {
    sourcesLoaded = false;
    void load();
  });
  exportReview.addEventListener("click", () => {
    if (!reviewEvidence) return;
    try {
      const prompt = buildReviewPrompt(reviewEvidence);
      const url = URL.createObjectURL(new Blob([prompt], { type: "text/plain;charset=utf-8" }));
      const link = el("a");
      link.href = url;
      link.download = "holotable-intel-review.txt";
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      message("Review prompt downloaded. No model was run. Choose a model explicitly using the optional review instructions below.");
    } catch (error) {
      message(errorText(error), true);
    }
  });

  return {
    /** Scope "op" | "fleet"; source "op:<id>", "archive:<key>" or "" (no operations). */
    show(nextScope, nextSource) {
      if (nextScope === scope && nextSource === source) return;
      scope = nextScope;
      source = nextSource;
      void load();
    },
    /** The next show() loads afresh, archive list included. */
    invalidate() {
      scope = null;
      sourcesLoaded = false;
    },
  };
}
