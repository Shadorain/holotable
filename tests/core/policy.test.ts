import { describe, expect, test } from "bun:test";
import { foldEvents } from "../../src/core/fold.ts";
import { actionsFor, launchRefusal, memoryLaunchRefusal } from "../../src/core/policy.ts";
import type {
  ActionView,
  Derived,
  Operation,
  PolicyInput,
} from "../../src/core/types.ts";
import {
  ev,
  makeContact,
  makeLane,
  makeOp,
  makeStatus,
} from "./fixtures.ts";

const EMPTY: Derived = foldEvents([]);

const policy = (
  op: Operation,
  ticket: string,
  over: Partial<PolicyInput> = {},
): PolicyInput => ({
  operation: op,
  contact: op.contacts.find((c) => c.ticket === ticket)!,
  derived: EMPTY,
  state: "ready",
  status: null,
  owner: "none",
  probe: null,
  load: { live: 0, open: 0 },
  cap: 8,
  conflictOpen: null,
  decisionPaneOpen: false,
  ...over,
});

const labels = (a: ActionView[]) =>
  a.map((x) => `${x.id}:${x.enabled ? "on" : "off"}${x.primary ? ":P" : ""}`);

describe("launchRefusal order", () => {
  const readyOp = () =>
    makeOp([makeContact("a")], { fleet: "omp-mission", frontend: "orca" });

  test("closed operation wins", () => {
    const op = readyOp();
    const d = foldEvents([ev(0, null, "closed", { outcome: "abandoned" })]);
    expect(launchRefusal(policy(op, "a", { derived: d }))).toBe("operation closed");
  });

  test("decision before already launched", () => {
    const op = makeOp([makeContact("a", { kind: "decision" })]);
    expect(launchRefusal(policy(op, "a"))).toBe("decision tickets do not launch");
  });

  test("already launched when terminal recorded", () => {
    const op = readyOp();
    op.contacts[0].lane = makeLane();
    expect(launchRefusal(policy(op, "a"))).toBe("already launched");
  });

  test("lane without terminal may still launch (resume)", () => {
    const op = readyOp();
    op.contacts[0].lane = makeLane({ terminal: null });
    const d = foldEvents(
      [ev(0, "a", "launch-failed", { step: "terminal", error: "x" })],
    );
    expect(launchRefusal(policy(op, "a", { derived: d }))).toBeNull();
  });

  test("blocked lists unmet blockers comma-joined", () => {
    const op = readyOp();
    op.contacts = [
      makeContact("b"),
      makeContact("c"),
      makeContact("a", { blockedBy: ["b", "c"] }),
    ];
    expect(launchRefusal(policy(op, "a"))).toBe("blocked by b, c");
  });

  test("cap before frontend before fleet", () => {
    const op = readyOp();
    expect(
      launchRefusal(policy(op, "a", { load: { live: 3, open: 8 } })),
    ).toBe("cap 8/8 omp");
    op.frontend = "none";
    expect(
      launchRefusal(policy(op, "a", { load: { live: 3, open: 2 } })),
    ).toBe("no frontend: choose Panes in Project settings");
    op.frontend = "orca";
    op.fleet = "none";
    expect(launchRefusal(policy(op, "a"))).toBe("no fleet configured");
    op.fleet = "omp-mission";
    expect(launchRefusal(policy(op, "a"))).toBeNull();
  });
});

describe("actionsFor", () => {
  const op = makeOp([makeContact("a", { lane: makeLane() })], {
    fleet: "omp-mission",
    frontend: "orca",
    delivery: "local-merge",
  });
  const queuedOp = makeOp([makeContact("a")], {
    fleet: "omp-mission",
    frontend: "orca",
  });

  test("ready: launch primary enabled when no refusal", () => {
    const a = actionsFor(policy(queuedOp, "a", { state: "ready" }));
    expect(labels(a)).toEqual(["launch:on:P"]);
  });

  test("ready: launch disabled carries refusal text", () => {
    const a = actionsFor(
      policy(queuedOp, "a", { state: "ready", load: { live: 8, open: 8 } }),
    );
    expect(a[0].enabled).toBe(false);
    expect(a[0].reason).toBe("cap 8/8 omp");
  });

  test("blocked: launch disabled with reason", () => {
    const blockedOp = makeOp(
      [makeContact("b"), makeContact("a", { blockedBy: ["b"] })],
      { fleet: "omp-mission", frontend: "orca" },
    );
    const a = actionsFor(policy(blockedOp, "a", { state: "blocked" }));
    expect(a[0].enabled).toBe(false);
    expect(a[0].reason).toBe("blocked by b");
  });

  test("decision: done primary", () => {
    const d = makeOp([makeContact("a", { kind: "decision" })]);
    const a = actionsFor(policy(d, "a", { state: "decision" }));
    expect(labels(a)).toEqual(["done:on:P", "decide-agent:off"]);
  });

  test("continue shows for a resume hold, as the primary when no gate is armed", () => {
    const status = makeStatus({ hold: "resume", actions: ["continue"] });
    const a = actionsFor(policy(op, "a", { state: "hold", status, owner: "live" }));
    expect(labels(a)).toContain("continue:on:P");
  });

  test("continue stays hidden while the mission runs fine, even when the mission offers it", () => {
    const status = makeStatus({ hold: "none", actions: ["approve", "continue", "reap", "clear"] });
    const a = actionsFor(policy(op, "a", { state: "running", status, owner: "live" }));
    expect(a.some(action => action.id === "continue")).toBe(false);
  });

  test("with Recovery on, a plain resume hold is left to the board; failed verification still asks you", () => {
    const recovering = { ...op, recover: true };
    const resume = makeStatus({ hold: "resume", actions: ["continue"] });
    expect(labels(actionsFor(policy(recovering, "a", { state: "hold", status: resume, owner: "live" })))).not.toContain("continue:on:P");
    const failed = makeStatus({ hold: "resume", verify: "failed", actions: ["continue"] });
    expect(labels(actionsFor(policy(recovering, "a", { state: "hold", status: failed, owner: "live" })))).toContain("continue:on:P");
  });

  test("planning: no fleet buttons when status is null", () => {
    const a = actionsFor(policy(op, "a", { state: "planning", status: null }));
    expect(labels(a)).toEqual(["focus:on", "reap:on"]);
  });

  test("offline: owner-offline disables fleet buttons", () => {
    const status = makeStatus({ actions: ["approve"] });
    const a = actionsFor(
      policy(op, "a", { state: "offline", status, owner: "offline" }),
    );
    const approve = a.find((x) => x.id === "approve");
    expect(approve?.enabled).toBe(false);
    expect(approve?.reason).toBe("owner-offline");
  });


  test("focus disabled when terminal missing or external", () => {
    const noTerm = makeOp([makeContact("a", { lane: makeLane({ terminal: null }) })]);
    const a = actionsFor(policy(noTerm, "a", { state: "planning" }));
    expect(a.find((x) => x.id === "focus")?.enabled).toBe(false);
    const ext = makeOp([makeContact("a", { lane: makeLane({ frontend: "external" }) })]);
    const b = actionsFor(policy(ext, "a", { state: "offline" }));
    expect(b.find((x) => x.id === "focus")?.reason).toBe("no frontend");
  });

  test("complete implement: land primary; done absent when delivery exists", () => {
    const status = makeStatus({ complete: true });
    const a = actionsFor(
      policy(op, "a", { state: "complete", status, owner: "live" }),
    );
    expect(labels(a)).toEqual(["land:on:P", "focus:on", "reap:on"]);
  });

  test("complete with no delivery: disabled land plus done", () => {
    const noDel = makeOp([makeContact("a", { lane: makeLane() })]);
    const status = makeStatus({ complete: true });
    const a = actionsFor(policy(noDel, "a", { state: "complete", status }));
    expect(labels(a)).toEqual(["land:off:P", "done:on", "focus:on", "reap:on"]);
    expect(a[0].reason).toBe("no delivery configured");
  });

  test("complete audit: done primary, no land", () => {
    const audit = makeOp(
      [makeContact("a", { kind: "audit", lane: makeLane() })],
      { fleet: "omp-mission", frontend: "orca", delivery: "local-merge" },
    );
    const a = actionsFor(
      policy(audit, "a", { state: "complete", status: makeStatus() }),
    );
    expect(labels(a)).toEqual(["done:on:P", "focus:on", "reap:on"]);
  });

  test("complete: probe closed and conflict reasons", () => {
    const status = makeStatus({ complete: true });
    const a = actionsFor(
      policy(op, "a", {
        state: "complete",
        status,
        probe: { url: "u", state: "closed", mergeable: "unknown", checks: "none" },
      }),
    );
    expect(a[0].reason).toBe("pull request closed");
    const b = actionsFor(
      policy(op, "a", { state: "complete", status, conflictOpen: "a-c-1" }),
    );
    expect(b[0].reason).toBe("conflict mission a-c-1 open");
  });

  test("complete with failing checks: Land waits, Land anyway is offered; the setting lands directly", () => {
    const status = makeStatus({ complete: true });
    const probe = { url: "u", state: "open" as const, mergeable: "clean" as const, checks: "fail" as const, failing: ["Verify policy change explanation"] };
    const blocked = actionsFor(policy(op, "a", { state: "complete", status, probe }));
    expect(blocked.find((a) => a.id === "land")).toMatchObject({ enabled: false, reason: "failing check: Verify policy change explanation" });
    expect(blocked.find((a) => a.id === "land-anyway")).toMatchObject({ enabled: true, primary: false });
    const ignoring = actionsFor(policy({ ...op, ignoreChecks: true }, "a", { state: "complete", status, probe }));
    expect(ignoring.find((a) => a.id === "land")).toMatchObject({ enabled: true, reason: null });
    const running = actionsFor(policy(op, "a", { state: "complete", status, probe: { ...probe, checks: "pending" as const, failing: [] } }));
    expect(running.find((a) => a.id === "land")).toMatchObject({ enabled: false, reason: "checks still running" });
    expect(running.some((a) => a.id === "land-anyway")).toBe(false);
    expect(ignoring.some((a) => a.id === "land-anyway")).toBe(false);
    // A closed PR is not something Land anyway can fix.
    const closed = actionsFor(policy(op, "a", { state: "complete", status, probe: { ...probe, state: "closed" } }));
    expect(closed.some((a) => a.id === "land-anyway")).toBe(false);
    // A PR that conflicts with the base: Land opens the conflict mission whatever its CI says.
    const conflicting = actionsFor(policy(op, "a", { state: "complete", status, probe: { ...probe, mergeable: "conflict" as const } }));
    expect(conflicting.find((a) => a.id === "land")).toMatchObject({ enabled: true, reason: null });
  });

  test("conflict: land disabled with open conflict reason", () => {
    const a = actionsFor(
      policy(op, "a", { state: "conflict", conflictOpen: "a-conflict-1" }),
    );
    expect(labels(a)).toEqual(["land:off:P", "focus:on", "reap:on"]);
    expect(a[0].reason).toBe("conflict mission a-conflict-1 open");
  });

  test("landed: Reap only while a terminal is still open; a decision offers only Change decision", () => {
    const a = actionsFor(policy(op, "a", { state: "landed" }));
    expect(labels(a)).toEqual(["reap:on"]);
    const d = foldEvents([ev(0, "a", "reaped")]);
    expect(actionsFor(policy(op, "a", { state: "landed", derived: d }))).toEqual([]);
    const decision = makeOp([makeContact("q", { kind: "decision" })]);
    expect(labels(actionsFor(policy(decision, "q", { state: "landed" })))).toEqual(["redecide:on"]);
  });
});

describe("state-specific edges", () => {
  test("reap disabled without terminal on live states", () => {
    const op = makeOp(
      [makeContact("a", { lane: makeLane({ terminal: null }) })],
      { fleet: "omp-mission", frontend: "orca" },
    );
    const a = actionsFor(
      policy(op, "a", { state: "running", status: makeStatus(), owner: "live" }),
    );
    expect(a.find((x) => x.id === "reap")?.enabled).toBe(false);
  });

  test("conflict-kind contact complete: no land, done offered", () => {
    const op = makeOp(
      [
        makeContact("a", { lane: makeLane() }),
        makeContact("a-c-1", { kind: "conflict", conflictOf: "a", lane: makeLane() }),
      ],
      { fleet: "omp-mission", frontend: "orca", delivery: "local-merge" },
    );
    const a = actionsFor(
      policy(op, "a-c-1", { state: "complete", status: makeStatus({ complete: true }) }),
    );
    expect(a.map((x) => x.id)).not.toContain("land");
    expect(a.find((x) => x.id === "done")?.enabled).toBe(true);
  });
});

describe("launch that stopped early", () => {
  const live = { fleet: "omp-mission", frontend: "orca" } as const;

  test("offline with a lane but no terminal offers Launch to resume", () => {
    const op = makeOp([makeContact("a", { lane: makeLane({ terminal: null }) })], live);
    expect(labels(actionsFor(policy(op, "a", { state: "offline" })))).toEqual(["launch:on:P", "focus:off", "reap:off"]);
  });

  test("offline with a terminal never offers Launch, and an adopted lane is not resumable", () => {
    const withTerminal = makeOp([makeContact("a", { lane: makeLane() })], live);
    expect(labels(actionsFor(policy(withTerminal, "a", { state: "offline" }))).some((l) => l.startsWith("launch"))).toBe(false);
    const adopted = makeOp([makeContact("a", { lane: makeLane({ terminal: null, frontend: "external" }) })], live);
    expect(labels(actionsFor(policy(adopted, "a", { state: "offline" }))).some((l) => l.startsWith("launch"))).toBe(false);
  });
});

test("memory admission leaves reserve and accounts for panes still opening", () => {
  const mib = 1024 * 1024;
  expect(memoryLaunchRefusal(1111 * mib)).not.toBeNull();
  expect(memoryLaunchRefusal(1112 * mib)).toBeNull();
  expect(memoryLaunchRefusal(1711 * mib, 1)).not.toBeNull();
  expect(memoryLaunchRefusal(1712 * mib, 1)).toBeNull();
  expect(memoryLaunchRefusal(null)).toBeNull();
});

describe("landing needs a real merge", () => {
  const lab = { fleet: "omp-mission", frontend: "orca", delivery: "github-pr" } as const;
  const open = { url: "https://github.com/x/pull/242", state: "open", mergeable: "clean", checks: "pass" } as const;
  const complete = (kind: "audit" | "implement", probe: PolicyInput["probe"], status = makeStatus({ complete: true })) => {
    const op = makeOp([makeContact("a", { kind, lane: makeLane() })], lab);
    return labels(actionsFor(policy(op, "a", { state: "complete", status, probe, owner: "live" })));
  };

  test("an audit that opened a PR lands through its PR like any code, never through Mark done", () => {
    expect(complete("audit", open)).toEqual(expect.arrayContaining(["land:on:P"]));
    expect(complete("audit", open).some((a) => a.startsWith("done"))).toBe(false);
  });

  test("an audit with nothing to merge still exits with Mark done", () => {
    expect(complete("audit", null)).toEqual(expect.arrayContaining(["done:on:P"]));
  });

  test("a PR merged outside the board offers recording it instead of a Land that would fail", () => {
    for (const kind of ["audit", "implement"] as const) {
      const a = complete(kind, { ...open, state: "merged" });
      expect(a).toEqual(expect.arrayContaining(["done:on:P"]));
      expect(a.some((x) => x.startsWith("land"))).toBe(false);
    }
  });

  test("Check PR shows on a finished mission only when the producer advertises it", () => {
    const without = complete("implement", open, makeStatus({ complete: true, actions: [] }));
    const offered = complete("implement", open, makeStatus({ complete: true, actions: ["check"] }));
    expect(without.some((a) => a.startsWith("check"))).toBe(false);
    expect(offered).toEqual(expect.arrayContaining(["check:on"]));
  });

  test("a finished mission whose pane died can be relaunched to work its open PR", () => {
    const op = makeOp([makeContact("a", { kind: "implement", lane: makeLane() })], lab);
    const status = makeStatus({ complete: true, actions: ["check"] });
    const at = (owner: PolicyInput["owner"], probe: PolicyInput["probe"]) =>
      labels(actionsFor(policy(op, "a", { state: "complete", status, probe, owner })));
    const dead = at("offline", { ...open, checks: "fail" });
    expect(dead.some((a) => a.startsWith("relaunch:on"))).toBe(true);
    expect(dead.some((a) => a.startsWith("check:on"))).toBe(false);
    expect(at("live", open).some((a) => a.startsWith("relaunch"))).toBe(false);
    expect(at("offline", { ...open, state: "merged" }).some((a) => a.startsWith("relaunch"))).toBe(false);
  });
});
