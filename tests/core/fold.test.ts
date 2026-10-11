import { describe, expect, test } from "bun:test";
import { foldEvents, liveCount } from "../../src/core/fold.ts";
import { findCycle, unmetBlockers } from "../../src/core/graph.ts";
import { ev, makeContact, makeOp, T0 } from "./fixtures.ts";

describe("foldEvents", () => {
  test("queued and launched set once", () => {
    const d = foldEvents(
      [
        ev(0, "a", "queued"),
        ev(10, "a", "launched", {
          worktree: "/w",
          frontend: "orca",
          terminal: { handle: "h", incarnationId: "i" },
        }),
        ev(20, "a", "queued"),
      ]
    );
    const c = d.contacts.a;
    expect(c.queuedAt).toBe(T0);
    expect(c.launchedAt).toBe(T0 + 10);
    expect(c.landed).toBe(false);
  });

  test("phase spans close on the next phase event", () => {
    const d = foldEvents(
      [
        ev(0, "a", "phase", { from: null, to: "plan" }),
        ev(30, "a", "phase", { from: "plan", to: "work" }),
      ]
    );
    expect(d.contacts.a.phaseSpans).toEqual([
      { phase: "plan", from: T0, to: T0 + 30 },
      { phase: "work", from: T0 + 30, to: null },
    ]);
    expect(d.contacts.a.lastPhase).toBe("work");
  });

  test("gate span closes on approve ok or phase", () => {
    const d = foldEvents(
      [
        ev(0, "a", "gate-armed", { gate: "g1" }),
        ev(40, "a", "operator", { op: "approve", ok: true }),
      ]
    );
    expect(d.contacts.a.gateSpans[0]).toEqual({ gate: "g1", from: T0, to: T0 + 40 });
    const d2 = foldEvents(
      [
        ev(0, "a", "gate-armed", { gate: "g1" }),
        ev(40, "a", "phase", { from: "x", to: "y" }),
      ]
    );
    expect(d2.contacts.a.gateSpans[0].to).toBe(T0 + 40);
    const d3 = foldEvents(
      [
        ev(0, "a", "gate-armed", { gate: "g1" }),
        ev(40, "a", "operator", { op: "approve", ok: false }),
      ]
    );
    expect(d3.contacts.a.gateSpans[0].to).toBeNull();
  });

  test("socket spans, landed, reaped, attempts", () => {
    const d = foldEvents(
      [
        ev(0, "a", "socket-up", { generation: 1 }),
        ev(10, "a", "socket-down"),
        ev(20, "a", "socket-up", { generation: 2 }),
        ev(30, "a", "land-attempt", { outcome: "conflict", paths: ["f"] }),
        ev(40, "a", "land-attempt", { outcome: "clean" }),
        ev(50, "a", "landed", { via: "merge" }),
        ev(60, "a", "reaped"),
      ]
    );
    const c = d.contacts.a;
    expect(c.socketEver).toBe(true);
    expect(c.socketUp).toBe(true);
    expect(c.downSpans).toEqual([{ from: T0 + 10, to: T0 + 20 }]);
    expect(c.landAttempts).toBe(2);
    expect(c.conflicts).toBe(1);
    expect(c.landed).toBe(true);
    expect(c.reaped).toBe(true);
  });

  test("landed and reaped close open spans at their timestamp", () => {
    const d = foldEvents(
      [
        ev(0, "a", "phase", { from: null, to: "work" }),
        ev(10, "a", "gate-armed", { gate: "g1" }),
        ev(20, "a", "socket-down"),
        ev(50, "a", "landed", { via: "merge" }),
      ]
    );
    const c = d.contacts.a;
    expect(c.landedAt).toBe(T0 + 50);
    expect(c.phaseSpans).toEqual([{ phase: "work", from: T0, to: T0 + 50 }]);
    expect(c.gateSpans).toEqual([{ gate: "g1", from: T0 + 10, to: T0 + 50 }]);
    expect(c.downSpans).toEqual([{ from: T0 + 20, to: T0 + 50 }]);
  });

  test("closed closes every contact's open spans at its timestamp", () => {
    const d = foldEvents(
      [
        ev(0, "a", "phase", { from: null, to: "work" }),
        ev(0, "b", "phase", { from: null, to: "plan" }),
        ev(70, null, "closed", { outcome: "landed" }),
      ]
    );
    expect(d.contacts.a.phaseSpans[0].to).toBe(T0 + 70);
    expect(d.contacts.b.phaseSpans[0].to).toBe(T0 + 70);
  });

  test("lastSample, peakOmp, usage, closed", () => {
    const d = foldEvents(
      [
        ev(0, "a", "sample", { omp: 2 }),
        ev(10, "a", "sample", { omp: 5, tracker: { state: "x", url: null } }),
        ev(20, "a", "sample", { omp: 3 }),
        ev(30, "a", "sample", { usage: { tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 } }),
        ev(40, "a", "sample", { usage: { tokens: { input: 20, output: 4, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.02 } }),
        ev(50, null, "closed", { outcome: "landed" }),
      ]
    );
    expect(d.contacts.a.lastOmp).toBe(3);
    expect(d.peakOmp).toBe(5);
    expect(d.contacts.a.lastSample?.tracker?.state).toBe("x");
    expect(d.contacts.a.lastSample?.omp).toBe(3);
    expect(d.contacts.a.lastSample?.usage?.tokens.input).toBe(20);
    expect(d.closed).toBe(true);
  });
});

describe("unmetBlockers / findCycle", () => {
  test("unmet blockers are blockers with no landed event", () => {
    const op = makeOp([
      makeContact("a"),
      makeContact("b", { blockedBy: ["a"] }),
      makeContact("c"),
      makeContact("d", { blockedBy: ["a", "c"] }),
    ]);
    const empty = foldEvents([]);
    expect(unmetBlockers(op, empty, "d")).toEqual(["a", "c"]);
    const landed = foldEvents([ev(0, "a", "landed", { via: "merge" })]);
    expect(unmetBlockers(op, landed, "d")).toEqual(["c"]);
    expect(unmetBlockers(op, empty, "ghost")).toEqual([]);
  });

  test("findCycle returns the cycle path or null", () => {
    expect(findCycle([{ ticket: "a", blockedBy: ["b"] }, { ticket: "b", blockedBy: ["a"] }]))
      .toEqual(["a", "b", "a"]);
    expect(findCycle([{ ticket: "a", blockedBy: ["b"] }, { ticket: "b", blockedBy: [] }]))
      .toBeNull();
  });
});

describe("liveCount", () => {
  test("counts lane.terminal minus reaped", () => {
    const op = makeOp([
      makeContact("a", { lane: { worktree: "/w", branch: null, frontend: "orca", terminal: { handle: "h", incarnationId: "i" } } }),
      makeContact("b"),
      makeContact("c", { lane: { worktree: "/w2", branch: null, frontend: "orca", terminal: { handle: "h2", incarnationId: "i2" } } }),
    ]);
    const d = foldEvents([ev(0, "c", "reaped")]);
    expect(liveCount(op, d)).toBe(1);
  });
});
