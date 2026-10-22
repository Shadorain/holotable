import { describe, expect, test } from "bun:test";
import {
  classifyCode,
  classifySeverity,
  classifyStatus,
  closerBlocks,
  closerHeadline,
  closerSection,
  closerTokens,
  followUpGroups,
  shortSha,
  tableCells,
} from "../web/closer-format.js";

const tickets = new Set(["CHR-12", "bd-pgf.1", "status"]);
const marked = (text) => closerTokens(text, tickets).filter((t) => t.kind !== "text").map((t) => [t.kind, t.value ?? t.path ?? t.text]);

describe("closer report sections", () => {
  test("headings people write map to panels, with or without numbering or emphasis", () => {
    expect(["Checked", "VERIFIED", "1. Verification", "Gates (exact commands)", "Gate results (verbatim)"].map(closerSection)).toEqual(Array(5).fill("checked"));
    expect(["Fixed", "2) Fixes", "**Fixed**"].map(closerSection)).toEqual(["fixed", "fixed", "fixed"]);
    expect(["Follow-ups", "Follow ups", "followup", "3. Follow-ups (not small)"].map(closerSection)).toEqual(Array(4).fill("follow-ups"));
    expect([closerSection("Findings"), closerSection("Summary")]).toEqual(["findings", "summary"]);
    expect(["Notes", "Seam checks", "CLOSER: op (bd-pgf.4)", "Unfixed bugs"].map(closerSection)).toEqual([null, null, null, null]);
  });

  test("blocks: a section runs to the next heading at its level, nests sub-headings, tables and output, and counts its items", () => {
    const md = [
      "# CLOSER: lab",
      "Intro with `70b60da`.",
      "## 1. Checked",
      "### Gates",
      "| # | Command | Result |",
      "|---|:--|--:|",
      "| 1 | `a \\| b` | **PASS** |",
      "| 2 | `make e2e` | NOT RUN |",
      "### Fixed things inside Checked",
      "- one",
      "## Fixed",
      "- first",
      "- second",
      "  - nested, not counted",
      "```",
      ...Array.from({ length: 13 }, (_, i) => `line ${i}`),
      "```",
      "## Appendix",
      "```text",
      "short",
      "```",
    ].join("\n");
    const [title, intro, checked, fixed, appendix, short] = closerBlocks(md);
    expect(title).toEqual({ type: "heading", level: 1, text: "CLOSER: lab" });
    expect(intro).toEqual({ type: "markdown", text: "Intro with `70b60da`." });
    expect(checked).toMatchObject({ type: "section", kind: "checked", level: 2, heading: "1. Checked", items: 1 });
    expect(checked.blocks.map((b) => b.type)).toEqual(["heading", "table", "heading", "markdown"]);
    expect(checked.blocks[1]).toEqual({ type: "table", head: ["#", "Command", "Result"], rows: [["1", "`a | b`", "**PASS**"], ["2", "`make e2e`", "NOT RUN"]] });
    expect(fixed).toMatchObject({ type: "section", kind: "fixed", items: 2 });
    expect(fixed.blocks.at(-1)).toMatchObject({ type: "fence", lang: "", long: true });
    expect(appendix).toEqual({ type: "heading", level: 2, text: "Appendix" });
    expect(short).toEqual({ type: "fence", lang: "text", lines: ["short"], long: false });
  });

  test("table cells keep pipes inside code spans and escaped pipes", () => {
    expect(tableCells("| `x | y` | a \\| b | c |")).toEqual(["`x | y`", "a | b", "c"]);
  });
});

describe("closer report tokens", () => {
  test("status words and marks", () => {
    expect(["PASS", "passed", "OK", "FAILED", "not run", "Skipped", "✅", "❌", "⚠️", "[x]", "[ ]"].map(classifyStatus)).toEqual(["pass", "pass", "pass", "fail", "skip", "skip", "pass", "fail", "warn", "pass", "open"]);
    expect(classifyStatus("clean")).toBeNull();
    expect(marked("Gate 1 PASSED, gate 2 FAILED, e2e NOT RUN, lint skipped: OK ✅ ❌ ⚠️ [x] [ ]").map(([, v]) => v)).toEqual(["pass", "fail", "skip", "skip", "pass", "pass", "fail", "warn", "pass", "open"]);
  });

  test("lowercase pass/fail and severity words in prose stay prose; labels and capitals do not", () => {
    expect(marked("all gates passed first time; a high number failed to matter")).toEqual([]);
    expect(marked("[high] one, (low) two, Medium: three, severity: critical, HIGH, P0 and P3")).toEqual([
      ["severity", "high"], ["severity", "low"], ["severity", "medium"], ["severity", "critical"], ["severity", "high"], ["severity", "critical"], ["severity", "low"],
    ]);
    expect(["high", "P2", "Critical"].map(classifySeverity)).toEqual(["high", "medium", "critical"]);
  });

  test("a run that is only a status, severity or ticket is one token (bold text, a table cell)", () => {
    expect(closerTokens("passed")).toEqual([{ kind: "status", text: "passed", value: "pass" }]);
    expect(closerTokens("Low")).toEqual([{ kind: "severity", text: "Low", value: "low" }]);
    expect(closerTokens("status", tickets)).toEqual([{ kind: "ticket", text: "status" }]);
  });

  test("paths with a directory and an extension or line, bare files only with a line, URLs left alone", () => {
    expect(marked("see crates/http/src/upload.rs:8, migration/dev_db.rs:15-33 and .github/ci.yml:16,33 then main.rs:203")).toEqual([
      ["path", "crates/http/src/upload.rs"], ["path", "migration/dev_db.rs"], ["path", ".github/ci.yml"], ["path", "main.rs"],
    ]);
    expect(closerTokens("x src/a.ts:12-30.").find((t) => t.kind === "path")).toEqual({ kind: "path", text: "src/a.ts:12-30", path: "src/a.ts", line: ":12-30" });
    expect(marked("and/or user/db/password apps/web knip.json e.g. Node.js https://github.com/o/r/blob/main/a.ts")).toEqual([]);
  });

  test("commit shas need a digit and a letter; operation tickets match whole ids only", () => {
    expect(marked("HEAD 70b60da, full 3f2c1ab9d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8; not decade, 1234567 or closer-063921")).toEqual([
      ["sha", "70b60da"], ["sha", "3f2c1ab9d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8"],
    ]);
    expect(marked("CHR-12 and bd-pgf.1. Not CHR-123, bd-pgf.10 or the status line")).toEqual([["ticket", "CHR-12"], ["ticket", "bd-pgf.1"]]);
  });

  test("code spans: ticket, sha, path or plain code", () => {
    const kinds = ["CHR-12", "70b60da", "apps/web/src/api/generated", "knip.json", "main.rs:101-120", "Makefile:25", ".github/**", "bun test", "status.actions", "#[allow(dead_code)]", "config.is_production()", "println!/eprintln!"].map((c) => classifyCode(c, tickets));
    expect(kinds).toEqual(["ticket", "sha", "path", "path", "path", "path", "path", "code", "code", "code", "code", "code"]);
  });
});

describe("closer review headline", () => {
  const coverage = (verdicts) => ({
    tickets: verdicts.map((verdict, i) => ({ ticket: `t${i}`, title: null, verdict, note: null })),
    total: verdicts.length,
    checked: verdicts.filter((v) => v !== "not-reported" && v !== "not-checked").length,
    fixed: verdicts.filter((v) => v === "fixed").length,
    followUps: 0,
  });
  const review = (over) => ({ v: 1, summary: "", verification: [], tickets: [], fixes: [], followUps: [], ...over });
  const run = (outcome) => ({ command: "bun test", outcome });

  test("all passed and every ticket checked reads ok, with coverage, fixes and follow-ups by severity", () => {
    const h = closerHeadline(review({ verification: [run("passed"), run("passed")], fixes: [{ title: "f" }], followUps: [{ title: "a", severity: "low" }, { title: "b", severity: "medium" }, { title: "c" }] }), coverage(["ok", "fixed"]));
    expect(h.tone).toBe("ok");
    expect(h.title).toBe("All verification passed (2)");
    expect(h.facts).toEqual([
      { text: "2/2 tickets checked", tone: null },
      { text: "1 fix", tone: null },
      { text: "3 follow-ups: 1 medium, 1 low, 1 unrated", tone: null },
    ]);
  });

  test("a failed command or an unreported ticket is bad; not run, not checked or a high follow-up is a warning", () => {
    expect(closerHeadline(review({ verification: [run("passed"), run("failed"), run("failed")] }), coverage(["ok"]))).toMatchObject({ tone: "bad", title: "2 verification commands failed" });
    expect(closerHeadline(review({ verification: [run("passed")] }), coverage(["ok", "not-reported"]))).toMatchObject({
      tone: "bad",
      facts: [{ text: "1/2 tickets checked (1 not reported)", tone: "bad" }, { text: "no fixes" }, { text: "no follow-ups" }],
    });
    expect(closerHeadline(review({ verification: [run("passed"), run("not-run")] }), coverage(["ok"]))).toMatchObject({ tone: "warn", title: "Verification passed, 1 not run" });
    expect(closerHeadline(review({ verification: [run("passed")] }), coverage(["not-checked"]))).toMatchObject({ tone: "warn", facts: [{ tone: "warn" }, {}, {}] });
    expect(closerHeadline(review({ verification: [run("passed")], followUps: [{ title: "x", severity: "high" }] }), coverage(["ok"]))).toMatchObject({
      tone: "warn",
      facts: [{ tone: null }, { tone: null }, { text: "1 follow-up: 1 high", tone: "warn" }],
    });
    expect(closerHeadline(review({}), coverage([]))).toMatchObject({ tone: "warn", title: "No verification recorded" });
  });

  test("follow-ups group high first, unrated last", () => {
    const groups = followUpGroups([{ title: "l", severity: "low" }, { title: "u" }, { title: "h", severity: "high" }, { title: "h2", severity: "high" }]);
    expect(groups.map((g) => [g.severity, g.items.map((i) => i.title)])).toEqual([["high", ["h", "h2"]], ["low", ["l"]], [null, ["u"]]]);
  });

  test("short shas: seven characters of a long hex sha, anything else as written", () => {
    expect([shortSha("3f2c1ab9d0e4"), shortSha("3f2c1ab"), shortSha("HEAD~1")]).toEqual(["3f2c1ab", "3f2c1ab", "HEAD~1"]);
  });
});
