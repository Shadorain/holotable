// Closer report formatting, pure: the closer's Markdown split into sections, tables and output blocks, its
// text cut into status, severity, path, commit and ticket tokens, and the JSON review's headline.
// No DOM here; web/closer.js builds the nodes.

// Report headings people and models actually use, by the panel they become. Numbering is stripped first.
const SECTIONS = [
  ["checked", /^(checked|checks|verified|verification|gates?\b|gate results)/],
  ["fixed", /^(fixed|fixes)\b/],
  ["follow-ups", /^follow[- ]?ups?\b/],
  ["findings", /^findings?\b/],
  ["summary", /^summary\b/],
];

/** The panel a report heading opens (`checked`, `fixed`, `follow-ups`, `findings`, `summary`), or null. */
export function closerSection(heading) {
  const text = heading
    .replace(/[*_`]/g, "")
    .trim()
    .replace(/^\(?\d+(?:\.\d+)*[.):]?\)?\s+/, "")
    .toLowerCase();
  for (const [kind, pattern] of SECTIONS) if (pattern.test(text)) return kind;
  return null;
}

const STATUS_WORDS = {
  pass: "pass",
  passed: "pass",
  ok: "pass",
  fail: "fail",
  failed: "fail",
  "not run": "skip",
  "not-run": "skip",
  skipped: "skip",
};
const SEVERITY_WORDS = { critical: "critical", high: "high", medium: "medium", low: "low", p0: "critical", p1: "high", p2: "medium", p3: "low" };
const MARKS = { "✅": "pass", "❌": "fail", "⚠️": "warn", "⚠": "warn", "[x]": "pass", "[X]": "pass", "[ ]": "open" };

/** A status word or mark (`PASS`, `not run`, `✅`, `[x]`) as pass | fail | skip | warn | open; null for anything else. */
export function classifyStatus(token) {
  const t = token.trim();
  return MARKS[t] ?? STATUS_WORDS[t.toLowerCase().replace(/\s+/g, " ")] ?? null;
}

/** A severity word or P-level (`high`, `P1`, `[low]`) as critical | high | medium | low; null for anything else. */
export function classifySeverity(token) {
  return SEVERITY_WORDS[token.trim().replace(/^[[(](.*)[\])]$/, "$1").toLowerCase()] ?? null;
}

// Extensions a bare file name (no directory) needs before it reads as a file rather than prose or a property.
const FILE_EXT = "rs|ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|toml|ya?ml|py|go|sh|css|html|sql|lock|txt|rb|java|kt|swift|c|h|cpp|hpp|vue|svelte|nix|env|ini|cfg|conf|xml|proto";
const LINES = String.raw`(?::\d+(?:[-,]\d+)*)`;
const PATH_SPLIT = new RegExp(String.raw`^(.*?)(${LINES})?$`);

/** `src/a.ts:12-30` as {path: "src/a.ts", line: ":12-30"} (line "" without one). */
export function splitPath(text) {
  const [, path, line = ""] = PATH_SPLIT.exec(text);
  return { path, line };
}

const SHA = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/;
const CODE_PATH_BARE = new RegExp(String.raw`^[\w.@-]+\.(?:${FILE_EXT})${LINES}?$`, "i");
const CODE_PATH_LINE = new RegExp(String.raw`^[A-Z][\w.-]*${LINES}$`);

/**
 * What a backticked span is: `ticket` (one of `tickets`), `sha`, `path` (has a slash, a known file extension
 * or a `Makefile:25`-style line) or plain `code` (commands, identifiers).
 */
export function classifyCode(code, tickets = new Set()) {
  const t = code.trim();
  if (tickets.has(t)) return "ticket";
  if (SHA.test(t)) return "sha";
  if (/\s|^-|:\/\/|[()"'=!<>;]/.test(t) || t.length < 3) return "code";
  if (t.includes("/") && /[\w*]/.test(t.replace(/\//g, ""))) return "path";
  if (CODE_PATH_BARE.test(t) || CODE_PATH_LINE.test(t)) return "path";
  return "code";
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Prose matchers, tried at each position; the earliest match wins, ties go to the first listed.
const PROSE = [
  // URLs stay text: their slashes and dots are not paths.
  ["url", /\b[a-z][a-z0-9+.-]*:\/\/[^\s)<>\]]+/gi],
  ["path", new RegExp(String.raw`(?<![\w/.@-])(?:\.{1,2}\/)?(?:[\w@.-]+\/)+[\w@-]+(?:\.[\w-]+)*(?:\.[A-Za-z][A-Za-z0-9]{0,7}${LINES}?|${LINES})(?![\w/])`, "g")],
  ["path", new RegExp(String.raw`(?<![\w/.@-])[\w@-]+(?:\.[\w-]+)*\.(?:${FILE_EXT})${LINES}(?![\w/])`, "gi")],
  ["sha", /(?<![\w-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w-])/g],
  ["status", /(?<![\w-])(?:NOT[ -]RUN|[Nn]ot[ -]run|PASSED|PASS|FAILED|FAIL|OK|SKIPPED|[Ss]kipped)(?![\w-])/g],
  ["status", /✅|❌|⚠️?|\[[ xX]\](?!\()/g],
  ["severity", /(?<![\w-])(?:P[0-3]|CRITICAL|HIGH|MEDIUM|LOW)(?![\w-])/g],
  // Lowercase severities only where they are clearly labels: [high], (low), "High:", "severity: medium".
  ["severity", /[[(](?:critical|high|medium|low)[\])]|(?<![\w-])(?:critical|high|medium|low)(?=:)|(?<=\bseverity:?\s{0,2})(?:critical|high|medium|low)\b/gi],
];

/**
 * Plain report text as tokens: {kind: "text", text} runs between status ({value: pass|fail|skip|warn|open}),
 * severity ({value}), path ({path, line}), sha and ticket tokens. `tickets` are the operation's contacts:
 * ones with a digit or in capitals (`CHR-12`, `bd-pgf.1`, `API`) match anywhere, a plain word (`status`)
 * only when it is the whole run (a bold or table-cell ticket), so prose words stay prose.
 */
export function closerTokens(text, tickets = new Set()) {
  const whole = text.trim();
  if (whole) {
    if (tickets.has(whole)) return [{ kind: "ticket", text }];
    const status = classifyStatus(whole);
    if (status) return [{ kind: "status", text, value: status }];
    const severity = classifySeverity(whole);
    if (severity) return [{ kind: "severity", text, value: severity }];
  }
  const idLike = [...tickets].filter((t) => /\d/.test(t) || /^[A-Z][A-Z0-9_-]*$/.test(t)).sort((a, b) => b.length - a.length);
  const matchers = idLike.length
    ? [...PROSE.slice(0, 1), ["ticket", new RegExp(`(?<![\\w.-])(?:${idLike.map(escapeRe).join("|")})(?![\\w-]|\\.\\w)`, "g")], ...PROSE.slice(1)]
    : PROSE;

  const out = [];
  const pushText = (s) => {
    if (!s) return;
    const last = out.at(-1);
    if (last?.kind === "text") last.text += s;
    else out.push({ kind: "text", text: s });
  };
  let at = 0;
  while (at < text.length) {
    let best = null;
    for (const [kind, re] of matchers) {
      re.lastIndex = at;
      const m = re.exec(text);
      if (m && (!best || m.index < best.m.index)) best = { kind, m };
    }
    if (!best) {
      pushText(text.slice(at));
      break;
    }
    const { kind, m } = best;
    pushText(text.slice(at, m.index));
    const token = m[0];
    if (kind === "url") pushText(token);
    else if (kind === "path") out.push({ kind, text: token, ...splitPath(token) });
    else if (kind === "status") out.push({ kind, text: token, value: classifyStatus(token) });
    else if (kind === "severity") out.push({ kind, text: token, value: classifySeverity(token) });
    else out.push({ kind, text: token });
    at = m.index + token.length;
  }
  return out;
}

// ---- blocks ----

const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
/** Fenced blocks longer than this fold behind a summary. */
const LONG_OUTPUT_LINES = 12;

/** One table row's cells; pipes inside backticks or escaped (`\|`) stay in the cell. */
export function tableCells(line) {
  const cells = [];
  let cell = "";
  let code = false;
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (ch === "`") {
      code = !code;
      cell += ch;
    } else if (ch === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

/** Top-level list items in a section's prose (`- x`, `1. x` at the left margin). */
const countItems = (blocks) =>
  blocks.filter((b) => b.type === "markdown").flatMap((b) => b.text.split("\n")).filter((l) => /^(?:[-*+]|\d+[.)])\s+\S/.test(l)).length;

/**
 * A closer's Markdown report as blocks for the closer formatter:
 * `section` ({kind, level, heading, items, blocks}) for a recognised heading (Checked, Fixed, Follow-ups, …),
 * `heading` ({level, text}) for any other, `table` ({head, rows}), `fence` ({lang, lines, long}) and
 * `markdown` ({text}) for everything the plain renderer handles. A section runs to the next heading at its
 * level or above; a recognised heading inside a section is a plain sub-heading. `items` counts the
 * section's top-level list items.
 */
export function closerBlocks(text) {
  const root = [];
  let section = null;
  let prose = [];
  const target = () => (section ? section.blocks : root);
  const flush = () => {
    if (prose.some((l) => l.trim())) target().push({ type: "markdown", text: prose.join("\n").replace(/^\n+|\n+$/g, "") });
    prose = [];
  };
  const close = () => {
    flush();
    if (section) section.items = countItems(section.blocks);
    section = null;
  };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const closing = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body = [];
      i += 1;
      while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
      i += 1;
      target().push({ type: "fence", lang: fence[2], lines: body, long: body.length > LONG_OUTPUT_LINES });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const kind = closerSection(heading[2]);
      if (section && level <= section.level) close();
      flush();
      if (kind && !section) {
        section = { type: "section", kind, level, heading: heading[2], items: 0, blocks: [] };
        root.push(section);
      } else target().push({ type: "heading", level, text: heading[2] });
      i += 1;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const head = tableCells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(tableCells(lines[i++]));
      target().push({ type: "table", head, rows });
      continue;
    }
    prose.push(line);
    i += 1;
  }
  close();
  return root;
}

// ---- JSON review ----

const SEVERITY_ORDER = ["high", "medium", "low"];

/** Follow-ups grouped by severity, high first, unrated last; empty groups left out. */
export function followUpGroups(followUps) {
  const groups = [...SEVERITY_ORDER, null].map((severity) => ({ severity, items: followUps.filter((f) => (f.severity ?? null) === severity) }));
  return groups.filter((g) => g.items.length);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The review's headline: `tone` (ok | warn | bad), a `title` on verification, and `facts` ({text, tone}:
 * coverage, fixes, follow-ups by severity), each fact toned by what it says. Bad: a command failed or a
 * landed ticket went unreported. Warn: a command was not run, a ticket was not checked, or a high follow-up is open.
 */
export function closerHeadline(review, coverage) {
  const runs = { passed: 0, failed: 0, "not-run": 0 };
  for (const v of review.verification) runs[v.outcome] += 1;
  const total = review.verification.length;
  let title;
  if (runs.failed) title = `${plural(runs.failed, "verification command")} failed`;
  else if (!total) title = "No verification recorded";
  else if (runs["not-run"]) title = `Verification passed, ${runs["not-run"]} not run`;
  else title = `All verification passed (${total})`;

  const unreported = coverage ? coverage.tickets.filter((t) => t.verdict === "not-reported").length : 0;
  const unchecked = coverage ? coverage.tickets.filter((t) => t.verdict === "not-checked").length : 0;
  const high = review.followUps.filter((f) => f.severity === "high").length;
  let tone = "ok";
  if (runs.failed || unreported) tone = "bad";
  else if (runs["not-run"] || unchecked || high || !total) tone = "warn";

  const facts = [];
  if (coverage) {
    const text = `${coverage.checked}/${coverage.total} tickets checked${unreported ? ` (${unreported} not reported)` : ""}`;
    let coverageTone = null;
    if (unreported) coverageTone = "bad";
    else if (unchecked) coverageTone = "warn";
    facts.push({ text, tone: coverageTone });
  }
  facts.push({ text: review.fixes.length ? plural(review.fixes.length, "fix", "fixes") : "no fixes", tone: null });
  const groups = followUpGroups(review.followUps);
  const followUps = groups.length ? `${plural(review.followUps.length, "follow-up")}: ${groups.map((g) => `${g.items.length} ${g.severity ?? "unrated"}`).join(", ")}` : "no follow-ups";
  facts.push({ text: followUps, tone: high ? "warn" : null });
  return { tone, title, facts };
}

/** A commit as shown on a chip: seven characters of a hex sha, anything else as written. */
export function shortSha(commit) {
  return /^[0-9a-f]{8,40}$/i.test(commit) ? commit.slice(0, 7) : commit;
}
