import { describe, expect, test } from "bun:test";
import { foldEvents } from "../../src/core/fold.ts";
import { computeStats } from "../../src/core/stats.ts";
import { ev, T0 } from "./fixtures.ts";

const NOW = T0 + 100_000;

describe("computeStats", () => {
  test("known timestamps produce exact stats", () => {
    const events = [
      ev(0, "a", "queued"),
      ev(10_000, "a", "launched", {
        worktree: "/w",
        frontend: "orca",
        terminal: { handle: "h", incarnationId: "i" },
      }),
      ev(10_000, "b", "queued"), // still queued: open wait runs to now
      ev(20_000, "a", "phase", { from: null, to: "plan" }),
      ev(50_000, "a", "phase", { from: "plan", to: "work" }), // plan: 30s
      ev(60_000, "a", "gate-armed", { gate: "g1" }),
      ev(75_000, "a", "operator", { op: "approve", ok: true }), // gate: 15s
      ev(80_000, "a", "socket-down"),
      ev(90_000, "a", "socket-up", { generation: 2 }), // down: 10s
      ev(90_000, "a", "land-attempt", { outcome: "conflict", paths: ["f"] }),
      ev(95_000, "a", "land-attempt", { outcome: "clean" }),
      ev(96_000, "a", "sample", { omp: 4 }),
      ev(97_000, "a", "sample", { usage: { tokens: { input: 1200, output: 300, cacheRead: 40, cacheWrite: 10 }, costUsd: 0.42 } }),
    ];
    const derived = foldEvents(events);
    const s = computeStats(derived, NOW, 2);
    expect(s.queueWaitMs).toEqual({ a: 10_000, b: NOW - (T0 + 10_000) });
    expect(s.queueWaitAvgMs).toBe((10_000 + 90_000) / 2);
    expect(s.phaseMs.plan).toBe(30_000);
    expect(s.phaseMs.work).toBe(NOW - (T0 + 50_000)); // open span to now
    expect(s.gateWaitMs).toBe(15_000);
    expect(s.socketDownMs).toBe(10_000);
    expect(s.landAttempts).toBe(2);
    expect(s.conflicts).toBe(1);
    expect(s.conflictRate).toBe(0.5);
    expect(s.tokens).toEqual({ input: 1200, output: 300, cacheRead: 40, cacheWrite: 10 });
    expect(s.costUsd).toBe(0.42);
    expect(s.omp).toEqual({ current: 2, peak: 4 });
  });

  test("fields without data are absent", () => {
    const s = computeStats(foldEvents([]), NOW, 0);
    expect(s.queueWaitMs).toEqual({});
    expect(s.queueWaitAvgMs).toBeUndefined();
    expect(s.phaseMs).toEqual({});
    expect(s.gateWaitMs).toBeUndefined();
    expect(s.landAttempts).toBe(0);
    expect(s.conflicts).toBe(0);
    expect(s.conflictRate).toBeUndefined(); // 0 attempts
    expect(s.socketDownMs).toBeUndefined();
    expect(s.omp).toEqual({ current: 0, peak: 0 });
  });

  test("same events and now recompute identically", () => {
    const events = [ev(0, "a", "queued"), ev(5_000, "a", "socket-up", { generation: 1 })];
    const a = computeStats(foldEvents(events), NOW, 1);
    const b = computeStats(foldEvents(events), NOW, 1);
    expect(a).toEqual(b);
  });

  test("events reconstructed from their JSON form compute identical stats", () => {
    const events = [
      ev(0, "a", "queued"),
      ev(10_000, "a", "launched", {
        worktree: "/w",
        frontend: "orca",
        terminal: { handle: "h", incarnationId: "i" },
      }),
      ev(10_000, "b", "queued"),
      ev(20_000, "a", "phase", { from: null, to: "plan" }),
      ev(50_000, "a", "phase", { from: "plan", to: "work" }),
      ev(60_000, "a", "gate-armed", { gate: "g1" }),
      ev(75_000, "a", "operator", { op: "approve", ok: true }),
      ev(80_000, "a", "socket-down"),
      ev(90_000, "a", "socket-up", { generation: 2 }),
      ev(90_000, "a", "land-attempt", { outcome: "conflict", paths: ["f"] }),
      ev(95_000, "a", "land-attempt", { outcome: "clean" }),
      ev(96_000, "a", "sample", { omp: 4 }),
    ];
    // events.jsonl round-trip: the same Stats from lines, never a stored counter
    const roundTripped = JSON.parse(JSON.stringify(events));
    const a = computeStats(foldEvents(events), NOW, 2);
    const b = computeStats(foldEvents(roundTripped), NOW, 2);
    expect(b).toEqual(a);
  });
});
