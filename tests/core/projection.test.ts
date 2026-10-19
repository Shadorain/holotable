import { describe, expect, test } from "bun:test";
import { project } from "../../src/core/projection.ts";
import type {
  ContactStatus,
  Operation,
  Owner,
  ProjectionInput,
} from "../../src/core/types.ts";
import {
  ev,
  iso,
  makeContact,
  makeLane,
  makeOp,
  makeStatus,
  T0,
} from "./fixtures.ts";

const NOW = T0 + 100_000;

const input = (op: Operation, over: Partial<ProjectionInput> = {}): ProjectionInput => ({
  operation: op,
  project: null,
  notesText: null,
  events: [],
  statuses: {},
  owners: {},
  probes: {},
  load: { live: 0, open: 0 },
  cap: 8,
  now: NOW,
  ...over,
});

const live = (terminal = true) =>
  makeLane({ terminal: terminal ? { handle: "h", incarnationId: "i" } : null });

const viewOf = (op: Operation, ticket: string, over: Partial<ProjectionInput> = {}) =>
  project(input(op, over)).contacts.find((c) => c.ticket === ticket)!;

test("a pending question needs attention and focuses its owner instead of approving or continuing", () => {
  const op = makeOp([makeContact("a", { lane: live() })], { fleet: "omp-mission", frontend: "orca", recover: true });
  const v = viewOf(op, "a", {
    statuses: { a: makeStatus({ hold: "question", next: "Answer in mission: Where should the parent hub live?", actions: ["plan-approve", "continue"] }) },
    owners: { a: "live" },
  });
  expect(v.state).toBe("hold");
  expect(v.attention).toBe(true);
  expect(v.detail).toContain("Where should the parent hub live?");
  expect(v.actions.filter(action => action.primary && action.enabled).map(action => action.id)).toEqual(["focus"]);
  expect(v.actions.some(action => action.id === "plan-approve" || action.id === "continue")).toBe(false);
});

describe("project: state table", () => {
  test("landed beats everything", () => {
    const op = makeOp([makeContact("a", { kind: "decision" })], {
      fleet: "omp-mission",
      frontend: "orca",
    });
    const v = viewOf(op, "a", {
      events: [ev(0, "a", "landed", { via: "manual" })],
    });
    expect(v.state).toBe("landed");
    expect(v.group).toBe("live");
  });

  test("lane-null decision is decision", () => {
    const op = makeOp([makeContact("a", { kind: "decision" })]);
    const v = viewOf(op, "a");
    expect(v.state).toBe("decision");
    expect(v.group).toBe("queue");
  });

  test("lane-null with unmet blocker is blocked", () => {
    const op = makeOp([makeContact("b"), makeContact("a", { blockedBy: ["b"] })]);
    expect(viewOf(op, "a").state).toBe("blocked");
  });

  test("lane-null free contact is ready", () => {
    const op = makeOp([makeContact("a")], { fleet: "omp-mission", frontend: "orca" });
    const v = viewOf(op, "a");
    expect(v.state).toBe("ready");
    expect(v.detail).toBe("Ready to launch");
  });

  test("ready detail is the refusal text when one exists", () => {
    const op = makeOp([makeContact("a")], { frontend: "none" });
    const v = viewOf(op, "a");
    expect(v.detail).toBe("no frontend: set one with /holotable set frontend orca");
  });

  test("unresolved conflict contact makes target conflict", () => {
    const op = makeOp(
      [
        makeContact("a", { lane: live() }),
        makeContact("a-c-1", { kind: "conflict", conflictOf: "a", lane: live() }),
      ],
      { fleet: "omp-mission", frontend: "orca" },
    );
    const statuses: Record<string, ContactStatus> = {
      a: makeStatus({}),
      "a-c-1": makeStatus({}),
    };
    expect(viewOf(op, "a", { statuses }).state).toBe("conflict");
    // Once every conflict contact is complete the target shows its own state.
    statuses["a-c-1"] = makeStatus({ complete: true });
    const v = viewOf(op, "a", { statuses });
    expect(v.state).toBe("running");
  });

  test("planning: terminal but no status and no socket-up", () => {
    const op = makeOp([makeContact("a", { lane: live() })]);
    const v = viewOf(op, "a");
    expect(v.state).toBe("planning");
  });

  test("offline: status null after socket-up, or owner offline", () => {
    const op = makeOp([makeContact("a", { lane: live() })]);
    const v = viewOf(op, "a", {
      events: [ev(0, "a", "socket-up", { generation: 1 })],
    });
    expect(v.state).toBe("offline");
    const v2 = viewOf(op, "a", {
      statuses: { a: makeStatus() },
      owners: { a: "offline" },
    });
    expect(v2.state).toBe("offline");
  });

  test("a dead quota-held pane is restartable without discarding its quota reason", () => {
    const op = makeOp([makeContact("a", { lane: live() })], { fleet: "omp-mission", frontend: "orca" });
    const statuses = { a: makeStatus({ hold: "quota", actions: ["continue"], next: "Provider quota exhausted" }) };
    const dead = viewOf(op, "a", { statuses, owners: { a: "offline" } });
    expect(dead.state).toBe("offline");
    expect(dead.detail).toContain("quota exhausted");
    expect(dead.actions.find((a) => a.id === "relaunch")?.enabled).toBe(true);
    expect(dead.actions.find((a) => a.id === "continue")?.enabled).not.toBe(true);
    const parked = viewOf(op, "a", { statuses, owners: { a: "live" } });
    expect(parked.state).toBe("hold");
    expect(parked.actions.find((a) => a.id === "continue")?.enabled).toBe(true);
  });

  test("a stopped worker requesting Resend needs attention, not a Running badge", () => {
    const op = makeOp([makeContact("a", { lane: live() })], { fleet: "omp-mission", frontend: "orca" });
    const stopped = makeStatus({ phase: "execute", hold: "none", workers: { live: 1, total: 4 }, actions: ["mode", "resend"] });
    const waiting = viewOf(op, "a", { statuses: { a: stopped }, owners: { a: "live" } });
    expect(waiting.state).toBe("hold");
    expect(waiting.attention).toBe(true);
    const dead = viewOf(op, "a", { statuses: { a: stopped }, owners: { a: "offline" } });
    expect(dead.state).toBe("offline");
    expect(dead.actions.find((a) => a.id === "relaunch")?.enabled).toBe(true);
    const finished = viewOf(op, "a", { statuses: { a: { ...stopped, complete: true } }, owners: { a: "live" } });
    expect(finished.state).toBe("complete");
    const active = viewOf(op, "a", { statuses: { a: { ...stopped, actions: ["mode", "dispatch"] } }, owners: { a: "live" } });
    expect(active.state).toBe("running");
  });

  test("Review mirrors the mission phase and requires attention only for an offered review", () => {
    const op = makeOp([makeContact("a", { lane: live() })]);
    const ready = makeStatus({ phase: "review", actions: ["review", "mode"] });
    const view = viewOf(op, "a", { statuses: { a: ready }, owners: { a: "live" } });
    expect(view.state).toBe("review");
    expect(view.attention).toBe(true);
    expect(view.actions.filter(a => a.primary && a.enabled).map(a => a.id)).toEqual(["review"]);
    const reviewing = viewOf(op, "a", { statuses: { a: { ...ready, actions: ["mode"] } }, owners: { a: "live" } });
    expect(reviewing.state).toBe("review");
    expect(reviewing.attention).toBe(false);
    expect(reviewing.actions.some(a => a.id === "review")).toBe(false);
  });

  test("deferred recovery is Waiting, while live, quota and disabled-recovery states remain authoritative", () => {
    const op = makeOp([makeContact("a", { lane: live() })], { recover: true, fleet: "omp-mission", frontend: "orca" });
    const statuses = { a: makeStatus({ phase: "review", actions: ["review", "mode"] }) };
    const recoveryWaits = { a: { kind: "memory" as const, detail: "Waiting for memory" } };
    const over = { statuses, owners: { a: "offline" as const }, recoveryWaits, vanished: new Set(["a"]) };
    const waiting = viewOf(op, "a", over);
    expect(waiting.state).toBe("waiting");
    expect(waiting.attention).toBe(false);
    expect(waiting.actions.find(a => a.id === "relaunch")?.enabled).toBe(false);
    expect(waiting.actions.find(a => a.id === "focus")?.enabled).toBe(false);
    expect(viewOf(op, "a", { ...over, owners: { a: "live" }, vanished: new Set() }).state).toBe("review");
    expect(viewOf({ ...op, recover: false }, "a", over).state).toBe("offline");
    expect(viewOf(op, "a", { ...over, statuses: { a: { ...statuses.a, hold: "quota" } } }).state).toBe("offline");
  });

  test("worker retry and blocker release remain producer-gated with one primary action", () => {
    const op = makeOp([makeContact("a", { lane: live() })]);
    const stopped = makeStatus({ hold: "blocked", actions: ["resend", "release", "mode"] });
    const view = viewOf(op, "a", { statuses: { a: stopped }, owners: { a: "live" } });
    expect(view.actions.filter(a => a.primary && a.enabled).map(a => a.id)).toEqual(["resend"]);
    expect(view.actions.find(a => a.id === "release")?.enabled).toBe(true);
    const unoffered = viewOf(op, "a", { statuses: { a: { ...stopped, actions: [] } }, owners: { a: "live" } });
    expect(unoffered.actions.some(a => ["resend", "release", "mode"].includes(a.id))).toBe(false);
    const dead = viewOf(op, "a", { statuses: { a: stopped }, owners: { a: "offline" } });
    expect(dead.actions.filter(a => ["resend", "release", "mode"].includes(a.id)).every(a => !a.enabled)).toBe(true);
  });

  test("offline: lane without terminal and no status", () => {
    const op = makeOp([makeContact("a", { lane: live(false) })]);
    expect(viewOf(op, "a").state).toBe("offline");
  });

  test("hold beats complete and phase", () => {
    const op = makeOp([makeContact("a", { lane: live() })]);
    const v = viewOf(op, "a", {
      statuses: { a: makeStatus({ hold: "gate", complete: true, phase: "verify" }) },
      owners: { a: "live" },
    });
    expect(v.state).toBe("hold");
  });

  test("complete, verify, running", () => {
    const op = makeOp([makeContact("a", { lane: live() })]);
    const statuses = (s: Partial<ContactStatus>) => ({ a: makeStatus(s) });
    const owners: Record<string, Owner> = { a: "live" };
    expect(
      viewOf(op, "a", { statuses: statuses({ complete: true }), owners }).state,
    ).toBe("complete");
    expect(
      viewOf(op, "a", { statuses: statuses({ phase: "verify" }), owners }).state,
    ).toBe("verify");
    expect(viewOf(op, "a", { statuses: statuses({}), owners }).state).toBe("running");
  });
});

describe("project: shape", () => {
  test("zone angles are -20 + i * 360/n", () => {
    const op = makeOp([], {
      zones: [
        { id: "z1", label: "A" },
        { id: "z2", label: "B" },
        { id: "z3", label: "C" },
        { id: "z4", label: "D" },
      ],
    });
    const p = project(input(op));
    expect(p.operation.zones.map((z) => z.angle)).toEqual([-20, 70, 160, 250]);
  });

  test("selection: first live, else first queued, else null", () => {
    const op = makeOp([makeContact("a"), makeContact("b", { lane: live() })]);
    const p = project(input(op));
    expect(p.selection).toBe("b");
    const queued = makeOp([makeContact("a")]);
    expect(project(input(queued)).selection).toBe("a");
    expect(project(input(makeOp([]))).selection).toBeNull();
  });

  test("header counts and group rule", () => {
    const op = makeOp([makeContact("a"), makeContact("b", { lane: live() })]);
    const p = project(
      input(op, {
        notesText: "## Checklist\n- [x] w1\n- [ ] w2\n",
        load: { live: 1, open: 2 },
      }),
    );
    expect(p.header).toEqual({
      live: 1,
      open: 2,
      cap: 8,
    });
    expect(p.notes).toEqual({ done: 1, total: 2 });
    const groups = Object.fromEntries(p.contacts.map((c) => [c.ticket, c.group]));
    expect(groups).toEqual({ a: "queue", b: "live" });
  });

  test("blockedBy carries landed flags", () => {
    const op = makeOp([
      makeContact("b"),
      makeContact("a", { blockedBy: ["b"] }),
    ]);
    const p = project(
      input(op, { events: [ev(0, "b", "landed", { via: "manual" })] }),
    );
    expect(p.contacts[1].blockedBy).toEqual([{ ticket: "b", landed: true }]);
    expect(p.contacts[1].state).toBe("ready");
  });

  test("tracker/delivery come from latest sample; probe overrides delivery", () => {
    const op = makeOp([makeContact("a", { lane: live() })]);
    const events = [
      ev(0, "a", "sample", {
        tracker: { state: "Todo", url: null },
        delivery: { url: null, state: "open", mergeable: "unknown", checks: "none" },
      }),
      ev(10, "a", "sample", {
        tracker: { state: "Doing", url: "u" },
      }),
    ];
    const p = project(input(op, { events }));
    expect(p.contacts[0].tracker).toEqual({ state: "Doing", url: "u" });
    expect(p.contacts[0].delivery?.state).toBe("open");
    const p2 = project(
      input(op, {
        events,
        probes: {
          a: { url: "u2", state: "merged", mergeable: "clean", checks: "pass" },
        },
      }),
    );
    expect(p2.contacts[0].delivery?.state).toBe("merged");
  });

  test("detail: status.next wins; conflict detail names the mission", () => {
    const op = makeOp([makeContact("a", { lane: live() })]);
    const v = viewOf(op, "a", {
      statuses: { a: makeStatus({ next: "/mission approve" }) },
      owners: { a: "live" },
    });
    expect(v.detail).toBe("/mission approve");
    const c = makeOp(
      [
        makeContact("a", { lane: live() }),
        makeContact("a-c-1", { kind: "conflict", conflictOf: "a", lane: live() }),
      ],
      { fleet: "omp-mission", frontend: "orca" },
    );
    const cv = viewOf(c, "a", {
      statuses: { a: makeStatus(), "a-c-1": makeStatus() },
    });
    expect(cv.detail).toBe("Waiting on conflict mission a-c-1");
  });

  test("progress, phase, workers, owner, conflictOf pass through", () => {
    const op = makeOp([makeContact("a", { lane: live() })]);
    const v = viewOf(op, "a", {
      statuses: {
        a: makeStatus({
          progress: { step: 2, of: 5 },
          phase: "work",
          workers: { live: 3, total: 4 },
        }),
      },
      owners: { a: "live" },
    });
    expect(v.progress).toEqual({ step: 2, of: 5 });
    expect(v.phase).toBe("work");
    expect(v.workers).toEqual({ live: 3, total: 4 });
    expect(v.owner).toBe("live");
    expect(v.conflictOf).toBeNull();
  });

  test("log is newest-first, max 50, classes ok/err/''", () => {
    const op = makeOp([makeContact("a")]);
    const events = [
      ev(0, "a", "queued"),
      ev(10, "a", "launched", {
        worktree: "/w",
        frontend: "orca",
        terminal: { handle: "h", incarnationId: "i" },
      }),
      ev(20, "a", "launch-failed", { step: "socket", error: "boom" }),
      ev(30, "a", "sample", { omp: 1 }),
      ev(40, "a", "operator", { op: "approve", ok: true }),
    ];
    const p = project(input(op, { events }));
    expect(p.log.map((l) => l.cls)).toEqual(["ok", "err", "ok", ""]);
    expect(p.log[0].at).toBe(iso(40));
    expect(p.log.some((l) => l.text.includes("sample"))).toBe(false);

    const many = Array.from({ length: 60 }, (_, i) => ev(i, "a", "queued"));
    const p2 = project(input(op, { events: many }));
    expect(p2.log.length).toBe(50);
    expect(p2.log[0].at).toBe(iso(59));
  });
});

test("a launch whose socket never came up reads offline, not planning forever", () => {
  const op = makeOp([makeContact("a", { lane: live() })], { fleet: "omp-mission", frontend: "orca" });
  const base = [ev(0, "a", "queued"), ev(1000, "a", "launched", { worktree: "/wt", frontend: "orca", terminal: { handle: "h", incarnationId: "i" } })];
  expect(viewOf(op, "a", { events: base }).state).toBe("planning");
  const failed = [...base, ev(2000, "a", "launch-failed", { step: "socket", error: "timeout" })];
  expect(viewOf(op, "a", { events: failed }).state).toBe("offline");
});

test("a finished mission stays complete (landable) once its owner is gone or its terminal reaped", () => {
  const op = makeOp([makeContact("a", { lane: live() })], { delivery: "local-merge" });
  const done = makeStatus({ complete: true, phase: "complete" });
  expect(viewOf(op, "a", { statuses: { a: done }, owners: { a: "offline" } }).state).toBe("complete");
  const reaped = [ev(0, "a", "queued"), ev(1, "a", "reaped")];
  expect(viewOf(op, "a", { statuses: { a: done }, owners: { a: "none" }, events: reaped }).state).toBe("complete");
});

test("an unfinished mission whose owner is gone or whose terminal was reaped reads offline", () => {
  const op = makeOp([makeContact("a", { lane: live() })]);
  const running = makeStatus({ phase: "execute" });
  expect(viewOf(op, "a", { statuses: { a: running }, owners: { a: "offline" } }).state).toBe("offline");
  expect(viewOf(op, "a", { statuses: { a: running }, owners: { a: "live" }, events: [ev(0, "a", "reaped")] }).state).toBe("offline");
});

test("a finished conflict mission points at the original's Land instead of asking for attention", () => {
  const op = makeOp(
    [makeContact("a", { lane: live() }), makeContact("a-c-1", { kind: "conflict", conflictOf: "a", lane: live() })],
    { fleet: "omp-mission", frontend: "orca", delivery: "local-merge" },
  );
  const done = makeStatus({ complete: true, phase: "complete" });
  const p = project(input(op, { statuses: { a: done, "a-c-1": done }, owners: { a: "live", "a-c-1": "live" } }));
  const resolver = p.contacts.find((c) => c.ticket === "a-c-1")!;
  const original = p.contacts.find((c) => c.ticket === "a")!;
  expect(resolver).toMatchObject({ state: "complete", attention: false, detail: "Conflicts resolved: land a" });
  expect(original.attention).toBe(true);
  expect(original.actions.find((x) => x.id === "land")).toMatchObject({ enabled: true, primary: true });
});

test("history names who acted: you, the model, the mission, or the board", () => {
  const op = makeOp([makeContact("a", { lane: live() }), makeContact("b", { blockedBy: ["a"] })]);
  const events = [
    ev(0, "a", "queued", { source: "operator" }),
    ev(1, "b", "queued", { source: "model" }),
    ev(2, "b", "blocked", { by: ["a"] }),
    ev(3, "a", "phase", { from: null, to: "plan" }),
    ev(4, "a", "operator", { op: "approve", ok: true }),
    ev(5, "a", "queued", { source: "conflict" }),
  ];
  const p = project(input(op, { events }));
  expect(p.log.map((l) => l.actor).reverse()).toEqual(["operator", "model", "board", "mission", "operator", "board"]);
  expect(viewOf(op, "b", { events }).origin).toMatchObject({ actor: "model", text: "queued by the model" });
  expect(viewOf(op, "a", { events }).origin?.text).toBe("added by you");
});

test("history credits auto mode and post-land cleanup to the board, an explicit Reap to you", () => {
  const op = makeOp([makeContact("a", { lane: live() }), makeContact("b", { lane: live() })]);
  const events = [
    // Auto mode landed a; the landing's cleanup closed its pane. The operator event closes the action.
    ev(0, "a", "landed", { via: "pr" }),
    ev(1, "a", "reaped"),
    ev(2, "a", "operator", { op: "land", ok: true, by: "auto" }),
    // You landed b by hand; cleanup closed the pane, then later nothing else.
    ev(3, "b", "landed", { via: "merge" }),
    ev(4, "b", "reaped"),
    ev(5, "b", "operator", { op: "land", ok: true }),
  ];
  const lines = project(input(op, { events })).log.slice().reverse();
  expect(lines.map((l) => `${l.contact}:${l.kind}:${l.actor}`)).toEqual([
    "a:landed:board",
    "a:reaped:board",
    "b:landed:operator",
    "b:reaped:board",
  ]);
  const reapedByHand = [ev(0, "b", "reaped"), ev(1, "b", "operator", { op: "reap", ok: true })];
  expect(project(input(op, { events: reapedByHand })).log[0]?.actor).toBe("operator");
});


test("a scheduled review cooldown is waiting, not running or a relaunch request", () => {
  const op = makeOp([makeContact("a", { lane: live() })], { frontend: "orca", fleet: "omp-mission" });
  const v = viewOf(op, "a", {
    statuses: { a: makeStatus({ phase: "review", next: "Review retries automatically at 22:05 UTC after: Reviewer error: 429 rate_limit_error", actions: ["mode"] }) },
    owners: { a: "live" },
  });
  expect(v.state).toBe("waiting");
  expect(v.problem?.kind).toBe("rate-limit");
  expect(v.attention).toBe(false);
  expect(v.actions.some(a => a.id === "relaunch")).toBe(false);
  expect(v.detail).toContain("22:05 UTC");
});

test("only a running pane's quota problem holds new AI work in auto mode", () => {
  const op = makeOp([makeContact("a", { lane: live() })], { frontend: "orca", fleet: "omp-mission",
    auto: { enabled: true, launch: true, land: true, maxLive: 4, plans: false, decide: false } });
  const statuses = { a: makeStatus({ hold: "quota", actions: ["continue"], next: "Provider quota exhausted",
    problem: { kind: "quota", source: "coordinator", detail: "quota exhausted", retryAt: null, attempt: null, completed: null, total: null } }) };
  expect(project(input(op, { statuses, owners: { a: "live" } })).operation.auto?.capacityWait).toContain("a");
  expect(project(input(op, { statuses, owners: { a: "offline" } })).operation.auto?.capacityWait).toBeNull();
  expect(project(input(op, { statuses, owners: { a: "none" }, events: [ev(0, "a", "reaped")] })).operation.auto?.capacityWait).toBeNull();
  expect(project(input(op, { statuses, owners: { a: "live" }, events: [ev(0, "a", "reaped")] })).operation.auto?.capacityWait).toBeNull();
});

test("review failure remains visible even when the producer does not offer a retry", () => {
  const op = makeOp([makeContact("a", { lane: live() })], { frontend: "orca", fleet: "omp-mission" });
  const status = makeStatus({ phase: "review", next: "Review failed (1/2 reviewers complete)", actions: [] });
  const failed = viewOf(op, "a", { statuses: { a: status }, owners: { a: "live" } });
  expect(failed.state).toBe("hold");
  expect(failed.attention).toBe(true);
  const recovered = viewOf(op, "a", { statuses: { a: { ...status, next: "Independent review running", problem: null } }, owners: { a: "live" } });
  expect(recovered.state).toBe("review");
  expect(recovered.problem).toBeNull();
  expect(recovered.attention).toBe(false);
});

test("a live review reports progress and model; past its deadline it asks for a relaunch", () => {
 const op = makeOp([makeContact("a", { lane: live() })], { frontend: "orca", fleet: "omp-mission" });
 const liveReview = { startedAt: iso(-60_000), deadlineAt: iso(200_000), active: 2, completed: 1, total: 3, models: ["p/m"] };
 const running = viewOf(op, "a", {
   statuses: { a: makeStatus({ phase: "review", next: "Independent review running", review: liveReview, model: "p/m" }) },
   owners: { a: "live" },
 });
 expect(running.state).toBe("review");
 expect(running.attention).toBe(false);
 expect(running.review).toEqual(liveReview);
 expect(running.model).toBe("p/m");
 const stalled = viewOf(op, "a", {
   statuses: { a: makeStatus({ phase: "review", next: "Independent review running", review: { ...liveReview, deadlineAt: iso(-1) }, model: "p/m" }) },
   owners: { a: "live" },
 });
 expect(stalled.state).toBe("review");
 expect(stalled.attention).toBe(true);
 expect(stalled.detail).toContain("Review stalled");
});

test("completed work with blocked landing needs attention instead of appearing to run", () => {
  const op = makeOp([makeContact("a", { lane: live() })], { delivery: "github-pr" });
  const v = viewOf(op, "a", {
    statuses: { a: makeStatus({ phase: "complete", complete: true, next: "/mission clear" }) },
    probes: { a: { url: "https://github.com/acme/repo/pull/7", state: "closed", mergeable: "unknown", checks: "pass" } },
  });
  expect(v.state).toBe("complete");
  expect(v.attention).toBe(true);
  expect(v.detail).toContain("pull request closed");
  expect(v.actions.find(action => action.id === "land")?.enabled).toBe(false);
});
