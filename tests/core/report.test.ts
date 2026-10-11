import { expect, test } from "bun:test";
import { buildReport } from "../../src/core/report.ts";
import { ev, iso, makeContact, makeLane, makeOp, T0 } from "./fixtures.ts";

const NOW = new Date(T0 + 120 * 60_000);

test("buildReport: counts and per-contact finals come from the events alone", () => {
  const op = makeOp(
    [
      makeContact("a", { title: "Landed one", lane: makeLane({ worktree: "/wt/a" }) }),
      makeContact("b", { lane: makeLane({ worktree: "/wt/b" }) }),
      makeContact("c"),
      makeContact("a-conflict-1", { kind: "conflict", conflictOf: "a", lane: makeLane({ worktree: "/wt/c" }) }),
    ],
  );
  const events = [
    ev(0, "a", "queued"),
    ev(1, "b", "queued"),
    ev(2, "c", "queued"),
    ev(5, "a", "launched", { worktree: "/wt/a", frontend: "orca", terminal: { handle: "h1", incarnationId: "i1" } }),
    ev(6, "b", "launched", { worktree: "/wt/b", frontend: "orca", terminal: { handle: "h2", incarnationId: "i2" } }),
    ev(10, "a", "land-attempt", { outcome: "conflict", paths: ["x.ts"] }),
    ev(11, "a-conflict-1", "queued", { source: "conflict" }),
    ev(12, "a-conflict-1", "launched", { worktree: "/wt/c", frontend: "orca", terminal: { handle: "h3", incarnationId: "i3" } }),
    ev(30, "a-conflict-1", "landed", { via: "merge" }),
    ev(31, "a", "land-attempt", { outcome: "clean" }),
    ev(32, "a", "landed", { via: "pr" }),
    ev(40, "a", "sample", { tracker: { state: "Done", url: "https://lin/a" }, delivery: { url: "https://gh/pr/1", state: "merged", mergeable: "clean", checks: "pass" } }),
    ev(60, null, "closed", { outcome: "abandoned" }),
  ];
  const report = buildReport(op, events, NOW, "# Brief\n\nSome text.", "## Checklist\n- [x] done\n- [ ] open\n");

  expect(report.v).toBe(1);
  expect(report.id).toBe("op1");
  expect(report.outcome).toBe("abandoned");
  expect(report.closedAt).toBe(iso(60));
  expect(report.durationMs).toBe(60);
  expect(report.counts).toEqual({ contacts: 4, landed: 2, conflicts: 1, launches: 3, landAttempts: 2 });
  expect(report.notes).toEqual({ done: 1, total: 2 });
  expect(report.notesText).toBe("## Checklist\n- [x] done\n- [ ] open\n");
  expect(report.brief).toBe("# Brief\n\nSome text.");

  const byTicket = new Map(report.contacts.map((c) => [c.ticket, c]));
  expect(byTicket.get("a")).toMatchObject({
    final: "landed",
    landedVia: "pr",
    landedAt: iso(32),
    trackerUrl: "https://lin/a",
    prUrl: "https://gh/pr/1",
  });
  // A lane with no landed event was torn down: aborted, not "not-launched".
  expect(byTicket.get("b")).toMatchObject({ final: "aborted", landedVia: null, landedAt: null });
  expect(byTicket.get("c")).toMatchObject({ final: "not-launched" });
  expect(byTicket.get("a-conflict-1")).toMatchObject({ final: "landed", landedVia: "merge", kind: "conflict" });
});

test("buildReport: no closed event falls back to now and outcome abandoned", () => {
  const op = makeOp([makeContact("a")]);
  const report = buildReport(op, [ev(0, "a", "queued")], NOW);
  expect(report.closedAt).toBe(NOW.toISOString());
  expect(report.outcome).toBe("abandoned");
  expect(report.counts.landed).toBe(0);
});

test("buildReport: brief is capped at 2000 chars, absent gives null", () => {
  const op = makeOp([makeContact("a")]);
  const report = buildReport(op, [], NOW, "x".repeat(5000));
  expect(report.brief).toHaveLength(2000);
  expect(buildReport(op, [], NOW).brief).toBeNull();
});
