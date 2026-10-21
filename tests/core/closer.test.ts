import { describe, expect, test } from "bun:test";
import { closerBrief } from "../../src/core/closer.ts";
import { project } from "../../src/core/projection.ts";
import type { Contact, Event, Operation, ProjectionInput } from "../../src/core/types.ts";
import { validateOperation } from "../../src/core/validate-operation.ts";
import { ev, makeContact, makeLane, makeOp, makeStatus, T0 } from "./fixtures.ts";

const NOW = T0 + 100_000;
const closer = (overrides: Partial<Contact> = {}) => makeContact("CLOSER", { kind: "closer", title: "Closer review", ...overrides });
const stack = { fleet: "omp-mission", frontend: "orca", delivery: "github-pr" } as const;

const viewOf = (op: Operation, ticket: string, over: Partial<ProjectionInput> = {}) =>
  project({ operation: op, project: null, notesText: null, events: [], statuses: {}, owners: {}, probes: {}, load: { live: 0, open: 0 }, cap: 8, now: NOW, ...over })
    .contacts.find((c) => c.ticket === ticket)!;
const landed = (ms: number, ticket: string) => ev(ms, ticket, "landed", { via: "pr" });

describe("closer validation", () => {
  const doc = (contacts: unknown[], tracker = "none") => ({
    v: 1, id: "op", name: "Op", repo: "/r", base: "main", integration: "/r", pause: false, tracker, fleet: "omp-mission", frontend: "orca",
    delivery: "github-pr", zones: [{ id: "z", label: "Z" }], contacts, project: null, createdAt: "2026-01-01T00:00:00.000Z",
  });
  const c = (ticket: string, extra: Record<string, unknown> = {}) => ({ ticket, zone: "z", blockedBy: [], ...extra });

  test("one closer per operation", () => {
    expect(validateOperation(doc([c("a"), c("CLOSER", { kind: "closer" })])).contacts.at(-1)?.kind).toBe("closer");
    expect(() => validateOperation(doc([c("x", { kind: "closer" }), c("y", { kind: "closer" })]))).toThrow("only one closer per operation (x, y)");
  });

  test("a closer lists no blockers and nothing waits on it", () => {
    expect(() => validateOperation(doc([c("a"), c("CLOSER", { kind: "closer", blockedBy: ["a"] })]))).toThrow("closer CLOSER must not list blockedBy");
    expect(() => validateOperation(doc([c("CLOSER", { kind: "closer" }), c("a", { blockedBy: ["CLOSER"] })]))).toThrow("a must not wait for closer CLOSER");
  });

  test("CLOSER is a valid closer ticket under a tracker; tracker-shaped closer tickets stay valid, others still are not", () => {
    expect(validateOperation(doc([c("CHR-1"), c("CLOSER", { kind: "closer" })], "linear")).contacts.map((x) => x.ticket)).toEqual(["CHR-1", "CLOSER"]);
    expect(validateOperation(doc([c("CHR-9", { kind: "closer" })], "linear")).contacts[0]?.kind).toBe("closer");
    expect(() => validateOperation(doc([c("CLOSER")], "linear"))).toThrow('ticket "CLOSER" is not a valid linear ticket');
  });
});

describe("closer blocking", () => {
  test("waits for every other contact, with one line of detail instead of a ticket list", () => {
    const op = makeOp([makeContact("a"), makeContact("b"), makeContact("d", { kind: "decision" }), closer()], stack);
    const v = viewOf(op, "CLOSER", { events: [landed(1, "a")] });
    expect(v.state).toBe("blocked");
    expect(v.detail).toBe("Waits for the rest of the operation to land (2 left)");
    expect(v.blockedBy).toEqual([]);
    expect(v.actions.find((a) => a.id === "launch")).toMatchObject({ enabled: false, reason: "Waits for the rest of the operation to land (2 left)" });
  });

  test("a contact added later blocks it again", () => {
    const events = [landed(1, "a")];
    const before = makeOp([makeContact("a"), closer()], stack);
    expect(viewOf(before, "CLOSER", { events }).state).toBe("ready");
    const after = makeOp([makeContact("a"), closer(), makeContact("late")], stack);
    expect(viewOf(after, "CLOSER", { events })).toMatchObject({ state: "blocked", detail: "Waits for the rest of the operation to land (1 left)" });
  });

  test("conflict missions never hold it: their target stands for them, and an abandoned one is done", () => {
    const op = makeOp([
      makeContact("a", { lane: makeLane() }),
      makeContact("a-conflict-1", { kind: "conflict", conflictOf: "a", lane: makeLane({ worktree: "/c" }) }),
      closer(),
    ], stack);
    expect(viewOf(op, "CLOSER", { events: [ev(1, "a-conflict-1", "reaped")] }).detail).toBe("Waits for the rest of the operation to land (1 left)");
    const v = viewOf(op, "CLOSER", { events: [ev(1, "a-conflict-1", "reaped"), landed(2, "a")] });
    expect(v.state).toBe("ready");
    expect(v.actions.find((a) => a.id === "launch")?.enabled).toBe(true);
  });

  test("decided decisions count as landed", () => {
    const op = makeOp([makeContact("d", { kind: "decision" }), closer()], stack);
    expect(viewOf(op, "CLOSER", { events: [ev(1, "d", "decided", { choice: "x", by: "operator" }), ev(1, "d", "landed", { via: "manual" })] }).state).toBe("ready");
  });
});

describe("closer completion", () => {
  const done = (probe: object | null) => {
    const op = makeOp([makeContact("a"), closer({ lane: makeLane() })], stack);
    return viewOf(op, "CLOSER", {
      events: [landed(1, "a")],
      statuses: { CLOSER: makeStatus({ complete: true, phase: "complete" }) },
      owners: { CLOSER: "live" },
      probes: probe ? { CLOSER: probe as never } : {},
    });
  };

  test("with no PR it is marked done; with one it lands through the usual checks", () => {
    expect(done(null).actions.find((a) => a.primary)).toMatchObject({ id: "done", label: "Mark done", enabled: true });
    expect(done({ url: "https://gh/pull/9", state: "open", mergeable: "clean", checks: "fail", failing: ["ci"] }).actions.find((a) => a.primary))
      .toMatchObject({ id: "land", enabled: false, reason: "failing check: ci" });
    expect(done({ url: "https://gh/pull/9", state: "open", mergeable: "clean", checks: "pass" }).actions.find((a) => a.primary)).toMatchObject({ id: "land", enabled: true });
  });

  test("auto mode says it marks the closer done or opens a PR for its commits", () => {
    const op = makeOp([makeContact("a"), closer({ lane: makeLane() })], { ...stack, auto: { enabled: true, launch: true, land: true, maxLive: 2, plans: false, decide: false } });
    const v = viewOf(op, "CLOSER", { events: [landed(1, "a")], statuses: { CLOSER: makeStatus({ complete: true, phase: "complete" }) }, owners: { CLOSER: "live" } });
    expect(v.handsOff).toBe("Auto mode marks this done, or opens a PR for its commits");
  });
});

describe("closer brief", () => {
  const sample = (ms: number, ticket: string, url: string) => ev(ms, ticket, "sample", { delivery: { url, state: "merged", mergeable: "clean", checks: "pass" } });
  const base = () => {
    const op = makeOp([
      makeContact("api", { title: "Ledger API", lane: makeLane({ branch: "holotable/api" }) }),
      makeContact("ui", { title: "Ledger UI", blockedBy: ["api"], lane: makeLane({ branch: "holotable/ui" }) }),
      makeContact("ui-conflict-1", { kind: "conflict", conflictOf: "ui", lane: makeLane({ branch: "conflict-ab12cd" }) }),
      makeContact("store", { kind: "decision", title: "Which store?", options: ["Postgres", "SQLite"] }),
      makeContact("todo", { title: "Not landed yet" }),
      closer({ description: "Pay attention to the migration order." }),
    ], { ...stack, name: "Ledger" });
    const events: Event[] = [
      sample(1, "api", "https://github.com/o/r/pull/11"),
      landed(2, "api"),
      ev(3, "ui", "land-attempt", { outcome: "conflict", paths: ["src/a.ts", "src/b.ts"] }),
      ev(3, "ui", "conflict-opened", { conflictContact: "ui-conflict-1" }),
      landed(4, "ui"),
      landed(4, "ui-conflict-1"),
      ev(5, "store", "decided", { choice: "Postgres", rationale: "We already run it", by: "operator" }),
      ev(5, "store", "landed", { via: "manual" }),
    ];
    return { op, events };
  };
  const build = (over: Partial<Parameters<typeof closerBrief>[0]> = {}) => {
    const { op, events } = base();
    return closerBrief({
      operation: op, closer: op.contacts.at(-1)!, events, briefText: "# Ledger\n\nAcceptance: totals match.",
      notesText: "## Plan\n\n- [x] API shipped\n- [ ] Docs updated\n```\n- [ ] not a task\n```", recommendations: ["One", "Two", "Three", "Four"],
      reportPath: "/home/op/closer/CLOSER.md", ...over,
    });
  };

  test("lists landed work with PRs or branches, decisions, conflict missions, the checklist and the operator's notes", () => {
    const text = build();
    expect(text).toStartWith("# Closer review of operation Ledger\n");
    expect(text).toContain("## Landed work (2)\n\n- api · Ledger API (implement) — https://github.com/o/r/pull/11 · landed 2026-01-01 00:00 UTC\n- ui · Ledger UI (implement) — branch holotable/ui");
    expect(text).not.toContain("Not landed yet");
    expect(text).toContain("- store · Which store?: **Postgres** — We already run it");
    expect(text).toContain("- ui-conflict-1 resolved landing ui · Ledger UI in src/a.ts, src/b.ts (landed)");
    expect(text).toContain("## Notes checklist\n\n- [x] API shipped\n- [ ] Docs updated\n\n");
    expect(text).not.toContain("not a task");
    expect(text).toContain("## Open Intel recommendations\n\n- One\n- Two\n- Three\n");
    expect(text).not.toContain("- Four");
    expect(text).toContain("## Operator notes for this review\n\nPay attention to the migration order.");
    expect(text).toContain("## Operation brief\n\n# Ledger\n\nAcceptance: totals match.");
    expect(text).toContain("write your report to `/home/op/closer/CLOSER.md`");
  });

  test("states the review instructions and the delivery the operation uses", () => {
    const text = build();
    for (const phrase of [
      "Fetch `main` and run the repository's full verification",
      "duplicated helpers, inconsistent APIs or naming, leftover TODO/FIXME/debug code, dead code from superseded approaches, docs that disagree with the code, and missing tests at the seams",
      "every notes checklist item",
      "Anything larger is a follow-up",
      "Never rewrite or revert landed history",
      "If nothing needs fixing, commit nothing and say so, with the evidence",
      "Do not push or open a pull request yourself",
    ]) expect(text).toContain(phrase);
    const { op } = base();
    expect(build({ operation: { ...op, delivery: "local-merge" } })).toContain("Do not merge into `main` yourself: Holotable merges this branch when it lands.");
  });

  test("stays bounded: long lists say how many were left out and a long brief is cut", () => {
    const many = Array.from({ length: 55 }, (_, i) => makeContact(`t${i}`));
    const op = makeOp([...many, closer()], stack);
    const text = closerBrief({
      operation: op, closer: op.contacts.at(-1)!, events: many.map((c, i) => landed(i, c.ticket)),
      briefText: "x".repeat(7000), notesText: Array.from({ length: 50 }, (_, i) => `- [ ] task ${i}`).join("\n"), recommendations: [], reportPath: "/r.md",
    });
    expect(text).toContain("## Landed work (55)");
    expect(text).toContain("- … and 15 more\n\n## Decisions");
    expect(text).toContain("- [ ] task 39\n- … and 10 more");
    expect(text).toContain("(brief truncated: 1000 more characters in the operation's brief.md)");
    expect(text).not.toContain("Open Intel recommendations");
    expect(text.length).toBeLessThan(12_000);
  });
});
