// The closer's review wherever it is shown: its card, the Operation page once it has landed and a closed
// operation's archive report. The JSON review (Contract 2) leads with a headline; an older closer's Markdown
// report goes through the closer formatter (web/closer-format.js). Every character lands via textContent.
import { classifyCode, closerBlocks, closerHeadline, closerTokens, followUpGroups, shortSha, splitPath } from "./closer-format.js";
import { icon } from "./icons.js";
import { renderInline, renderMarkdown } from "./markdown.js";
import { el } from "./ui.js";

// Every builder here takes `opts`: `tickets`, the operation's contact tickets (a Set) the report may name,
// and `linkable`, whether those open the contact's card (an archived operation has no cards).

/** A ticket as a chip; one of an open operation's contacts opens its card. */
function ticketChip(ticket, opts, label = ticket) {
  if (!opts.linkable || !opts.tickets.has(ticket)) return el("span", "cf-ticket", label);
  const btn = el("button", "rel cf-ticket", label);
  btn.type = "button";
  btn.title = `Open ${ticket}`;
  btn.dataset.id = ticket;
  btn.dataset.key = `cf/${ticket}`;
  return btn;
}

const MARK_LABEL = { "✅": "pass", "❌": "fail", "⚠️": "warn", "⚠": "warn", "[x]": "done", "[X]": "done", "[ ]": "open" };

function pathChip(path, line) {
  const chip = el("code", "cf-path", path);
  chip.title = path + line;
  if (line) chip.append(el("span", "cf-line", line));
  return chip;
}

function shaChip(sha) {
  const chip = el("code", "cf-sha", shortSha(sha));
  chip.title = `commit ${sha}`;
  return chip;
}

function tokenNode(token, opts) {
  switch (token.kind) {
    case "status":
      return el("span", `cf-badge cf-${token.value}`, MARK_LABEL[token.text] ?? token.text.trim());
    case "severity":
      return el("span", `cf-badge cf-sev-${token.value}`, token.text.trim().replace(/^[[(]|[\])]$/g, ""));
    case "path":
      return pathChip(token.path, token.line);
    case "sha":
      return shaChip(token.text);
    case "ticket":
      return ticketChip(token.text.trim(), opts);
    default:
      return document.createTextNode(token.text);
  }
}

/** The inline hooks renderMarkdown takes: report text becomes badges and chips, code spans chips where they fit. */
function inlineFormat(opts) {
  return {
    text(into, run) {
      for (const token of closerTokens(run, opts.tickets)) into.append(tokenNode(token, opts));
    },
    code(into, code) {
      const kind = classifyCode(code, opts.tickets);
      if (kind === "ticket") into.append(ticketChip(code.trim(), opts));
      else if (kind === "sha") into.append(shaChip(code.trim()));
      else if (kind === "path") {
        const { path, line } = splitPath(code.trim());
        into.append(pathChip(path, line));
      } else into.append(el("code", "", code));
    },
  };
}

const PANEL_ICON = { checked: "shield-check", fixed: "check", "follow-ups": "flag", findings: "triangle-alert", summary: "file-text" };

function blockNode(block, format) {
  if (block.type === "section") {
    const panel = el("section", "cf-panel");
    const head = el("div", "cf-panel-head");
    head.append(icon(PANEL_ICON[block.kind], { size: 14 }));
    const title = el("span", "cf-panel-title");
    renderInline(title, block.heading, format);
    head.append(title);
    if (block.items && (block.kind === "fixed" || block.kind === "follow-ups")) head.append(el("span", "count", String(block.items)));
    panel.append(head);
    for (const child of block.blocks) panel.append(blockNode(child, format));
    return panel;
  }
  if (block.type === "heading") {
    const h = el(`h${Math.min(6, block.level + 2)}`, "cf-heading");
    renderInline(h, block.text, format);
    return h;
  }
  if (block.type === "table") {
    const wrap = el("div", "cf-table-wrap");
    const table = el("table", "cf-table");
    const head = el("tr", "");
    for (const cell of block.head) {
      const th = el("th", "");
      renderInline(th, cell, format);
      head.append(th);
    }
    const thead = el("thead", "");
    thead.append(head);
    const tbody = el("tbody", "");
    for (const row of block.rows) {
      const tr = el("tr", "");
      for (const cell of row) {
        const td = el("td", "");
        renderInline(td, cell, format);
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody);
    wrap.append(table);
    return wrap;
  }
  if (block.type === "fence") {
    const pre = el("pre", "md-code cf-output-text");
    pre.append(el("code", "", block.lines.join("\n")));
    if (!block.long) return pre;
    const details = el("details", "cf-output");
    details.append(el("summary", "", `${block.lang || "Output"} · ${block.lines.length} lines`), pre);
    return details;
  }
  return renderMarkdown(block.text, { format });
}

/** An older closer's Markdown report: sections as panels, status and severity badges, path, commit and ticket chips. */
function closerMarkdown(text, opts) {
  const root = el("div", "card-desc cf-md");
  const format = inlineFormat(opts);
  for (const block of closerBlocks(text)) root.append(blockNode(block, format));
  return root;
}

const TONE_ICON = { ok: "shield-check", warn: "triangle-alert", bad: "circle-x" };
const VERDICT_COPY = { ok: "ok", fixed: "fixed", "follow-up": "follow-up", "not-checked": "not checked", "not-reported": "not reported" };
const RUN_MARK = { passed: ["check", "passed"], failed: ["x", "failed"], "not-run": ["minus", "not run"] };

function headline(review, coverage) {
  const h = closerHeadline(review, coverage);
  const banner = el("div", `cf-banner cf-tone-${h.tone}`);
  banner.append(icon(TONE_ICON[h.tone], { size: 18 }));
  const text = el("div", "cf-banner-text");
  const facts = el("div", "cf-facts");
  for (const fact of h.facts) facts.append(el("span", fact.tone ? `cf-fact-${fact.tone}` : "", fact.text));
  text.append(el("div", "cf-banner-title", h.title), facts);
  banner.append(text);
  return banner;
}

/** One chip per landed ticket coloured by verdict; a click shows its note and, on an open operation, a way to its card. */
function verdictGrid(coverage, opts) {
  const box = el("div", "cf-verdicts");
  const grid = el("div", "verdict-grid");
  const note = el("div", "verdict-note");
  note.hidden = true;
  for (const t of coverage.tickets) {
    const chip = el("button", `verdict v-${t.verdict}`, t.ticket);
    chip.type = "button";
    const label = `${t.ticket}${t.title ? ` · ${t.title}` : ""}: ${VERDICT_COPY[t.verdict]}`;
    chip.title = t.note ? `${label}. ${t.note}` : label;
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => {
      const open = chip.getAttribute("aria-pressed") !== "true";
      for (const other of grid.children) other.setAttribute("aria-pressed", "false");
      chip.setAttribute("aria-pressed", String(open));
      note.hidden = !open;
      note.replaceChildren(el("span", "", t.note ? `${label}. ${t.note}` : `${label}. No note.`));
      if (opts.linkable && opts.tickets.has(t.ticket)) note.append(ticketChip(t.ticket, opts, `Open ${t.ticket}`));
    });
    grid.append(chip);
  }
  const legend = el("div", "verdict-legend");
  for (const [verdict, text] of Object.entries(VERDICT_COPY)) {
    const n = coverage.tickets.filter((t) => t.verdict === verdict).length;
    if (n) legend.append(el("span", `v-${verdict}`, `${text} ${n}`));
  }
  box.append(grid, legend, note);
  return box;
}

function part(label, ...children) {
  const box = el("div", "report-part");
  box.append(el("div", "report-label", label), ...children);
  return box;
}

function inlineText(cls, text, format) {
  const node = el("span", cls);
  renderInline(node, text, format);
  return node;
}

function ticketChips(tickets, opts) {
  const box = el("span", "cf-chips");
  for (const t of tickets ?? []) box.append(ticketChip(t, opts));
  return box;
}

/**
 * The closer's JSON review: headline banner (verification, coverage, fixes, follow-ups by severity), summary,
 * verdict grid, verification checklist, fixes and follow-ups, high first.
 */
function closerReviewView(review, coverage, opts) {
  const format = inlineFormat(opts);
  const view = el("div", "cf-review");
  view.append(headline(review, coverage));
  if (review.summary) {
    const summary = el("div", "card-desc report-summary");
    summary.append(renderMarkdown(review.summary, { format }));
    view.append(summary);
  }
  if (coverage?.tickets.length) view.append(verdictGrid(coverage, opts));
  if (review.verification.length) {
    const list = el("ul", "report-list cf-checklist");
    for (const v of review.verification) {
      const [mark, word] = RUN_MARK[v.outcome];
      const li = el("li", `cf-run-${v.outcome}`);
      const tick = el("span", "cf-mark");
      tick.setAttribute("role", "img");
      tick.setAttribute("aria-label", word);
      tick.title = word;
      tick.append(icon(mark, { size: 13 }));
      li.append(tick, el("code", "", v.command));
      if (v.outcome !== "passed") li.append(el("span", `cf-badge cf-${v.outcome === "failed" ? "fail" : "skip"}`, word));
      if (v.note) li.append(inlineText("dim", v.note, format));
      list.append(li);
    }
    view.append(part("Verification", list));
  }
  if (review.fixes.length) {
    const list = el("ul", "report-list cf-fixes");
    for (const f of review.fixes) {
      const li = el("li", "");
      li.append(inlineText("", f.title, format));
      if (f.commit) li.append(shaChip(f.commit));
      li.append(ticketChips(f.tickets, opts));
      if (f.files?.length) {
        const files = el("div", "cf-files");
        for (const file of f.files) {
          const { path, line } = splitPath(file);
          files.append(pathChip(path, line));
        }
        li.append(files);
      }
      list.append(li);
    }
    view.append(part(`Fixes (${review.fixes.length})`, list));
  }
  if (review.followUps.length) {
    const list = el("ul", "report-list cf-followups");
    for (const g of followUpGroups(review.followUps)) {
      for (const f of g.items) {
        const li = el("li", "");
        const item = el("div", "cf-item");
        item.append(inlineText("", f.title, format), ticketChips(f.tickets, opts));
        if (f.detail) item.append(inlineText("dim report-detail", f.detail, format));
        li.append(el("span", `cf-badge cf-sev-${g.severity ?? "none"}`, g.severity ?? "unrated"), item);
        list.append(li);
      }
    }
    view.append(part(`Follow-ups (${review.followUps.length})`, list));
  }
  return view;
}

/**
 * What the closer reported, from its view (`{review, coverage, report, reviewError}`): the JSON review, else
 * the Markdown report; an unreadable review says why. Empty when it has written neither.
 */
export function closerBody(data, opts) {
  const parts = [];
  if (data.reviewError) parts.push(el("div", "set-err", data.reviewError));
  if (data.review) parts.push(closerReviewView(data.review, data.coverage, opts));
  else if (data.report) parts.push(closerMarkdown(data.report, opts));
  return parts;
}

/** The headline section of an Operation page or archive report: the closer's review, or null before it wrote one. */
export function closerOverview(data, opts) {
  if (!data || data.error) return null;
  const body = closerBody(data, opts);
  if (!body.length) return null;
  const box = el("section", "opdoc-sec closer-report closer-overview");
  const head = el("div", "group-head");
  head.append(el("span", "", "Closer review"), el("span", "mono dim", data.ticket));
  box.append(head, ...body);
  return box;
}
