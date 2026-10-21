import { describe, expect, test } from "bun:test";
import { validateEvent } from "../../src/core/validate-event.ts";

const base = { v: 1 as const, at: "2026-01-01T00:00:00.000Z" };
const contact = { ...base, contact: "a" };

const bad = (v: unknown): string => {
  try {
    validateEvent(v);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("validateEvent", () => {
  test("prefix and envelope", () => {
    expect(bad(null)).toBe("Invalid event at events.jsonl: expected a JSON object");
    expect(bad({ ...contact, v: 2, kind: "queued" })).toContain("v must be 1");
    expect(bad({ ...contact, at: "not a date", kind: "queued" })).toContain("at must be");
    expect(bad({ v: 1, at: base.at, contact: "a" })).toContain("kind must be a string");
    expect(bad({ ...contact, kind: "bogus" })).toContain('unknown kind "bogus"');
  });

  test("contact required for contact kinds, absent for workflow/closed", () => {
    expect(bad({ v: 1, at: base.at, kind: "queued" })).toContain("requires contact");
    expect(bad({ ...base, kind: "workflow", contact: "a", item: "x", done: true }))
      .toContain("must not carry a contact");
    expect(bad({ ...base, kind: "closed", contact: "a", outcome: "landed" }))
      .toContain("must not carry a contact");
  });

  test("each contact kind validates its extras", () => {
    expect(validateEvent({ ...contact, kind: "queued" }).kind).toBe("queued");
    expect(bad({ ...contact, kind: "blocked" })).toContain("by must be");
    const blocked = validateEvent({ ...contact, kind: "blocked", by: ["a"] });
    if (blocked.kind === "blocked") expect(blocked.by).toEqual(["a"]);
    expect(bad({ ...contact, kind: "adopted" })).toContain("worktree");
    expect(bad({ ...contact, kind: "launched", worktree: "/w", frontend: "orca" }))
      .toContain("terminal must be an object");
    expect(
      bad({
        ...contact,
        kind: "launched",
        worktree: "/w",
        frontend: "orca",
        terminal: { handle: "", incarnationId: "i" },
      }),
    ).toContain("terminal.handle");
    expect(bad({ ...contact, kind: "launch-failed", step: "nope", error: "e" }))
      .toContain("step must be one of");
    expect(bad({ ...contact, kind: "launch-failed", step: "socket" }))
      .toContain("error");
    expect(bad({ ...contact, kind: "socket-up", generation: "3" }))
      .toContain("generation must be a number");
    expect(validateEvent({ ...contact, kind: "phase", to: "work" })).toBeDefined();
    expect(bad({ ...contact, kind: "phase", from: 5, to: "work" })).toContain("from");
    expect(bad({ ...contact, kind: "gate-armed" })).toContain("gate");
    expect(bad({ ...contact, kind: "operator", op: "approve" })).toContain("ok must be");
    expect(
      bad({ ...contact, kind: "operator", op: "approve", ok: false, error: 3 }),
    ).toContain("error must be a string");
    expect(bad({ ...contact, kind: "land-attempt", outcome: "maybe" }))
      .toContain("outcome must be one of");
    expect(bad({ ...contact, kind: "land-attempt", outcome: "conflict", paths: "x" }))
      .toContain("paths must be");
    expect(bad({ ...contact, kind: "conflict-opened" })).toContain("conflictContact");
    expect(bad({ ...contact, kind: "landed", via: "yolo" })).toContain("via must be one of");
    expect(bad({ ...contact, kind: "landed" })).toContain("via");
    expect(validateEvent({ ...contact, kind: "socket-down" }).kind).toBe("socket-down");
    expect(validateEvent({ ...contact, kind: "reaped" }).kind).toBe("reaped");
  });

  test("sample field shapes", () => {
    expect(validateEvent({ ...contact, kind: "sample" }).kind).toBe("sample");
    expect(bad({ ...contact, kind: "sample", tracker: { url: "u" } }))
      .toContain("tracker.state");
    expect(bad({ ...contact, kind: "sample", delivery: { url: null, state: "open" } }))
      .toContain("delivery");
    expect(bad({ ...contact, kind: "sample", workers: "3" })).toContain("workers");
    expect(bad({ ...contact, kind: "sample", omp: NaN })).toContain("omp");
    const s = validateEvent({
      ...contact,
      kind: "sample",
      tracker: { state: "In Progress", url: "https://x" },
      delivery: { url: "u", state: "open", mergeable: "clean", checks: "pass" },
      omp: 2,
    });
    expect(s.kind).toBe("sample");
    if (s.kind === "sample") {
      expect(s.tracker?.state).toBe("In Progress");
      expect(s.omp).toBe(2);
      expect(s.workers).toBeUndefined();
    }
  });

  test("workflow and closed", () => {
    expect(
      validateEvent({ ...base, kind: "workflow", item: "w1", done: true }),
    ).toEqual({ v: 1, at: base.at, kind: "workflow", item: "w1", done: true });
    expect(bad({ ...base, kind: "workflow", item: "w1" })).toContain("done");
    expect(
      validateEvent({ ...base, kind: "closed", outcome: "abandoned" }),
    ).toEqual({ v: 1, at: base.at, kind: "closed", outcome: "abandoned" });
    expect(bad({ ...base, kind: "closed", outcome: "nope" })).toContain("outcome");
  });

  test("mission problems keep only kind, source and retryAt", () => {
    const mission = { id: "m", hold: "quota" as const, verify: null, complete: false };
    const problem = { kind: "rate-limit", source: "review", detail: "429 from provider", retryAt: "2026-01-01T00:05:00.000Z", attempt: 2 };
    expect(validateEvent({ ...contact, kind: "sample", mission: { ...mission, problem } })).toEqual({
      ...contact, kind: "sample", mission: { ...mission, problem: { kind: "rate-limit", source: "review", retryAt: "2026-01-01T00:05:00.000Z" } },
    });
    expect(validateEvent({ ...contact, kind: "sample", mission: { ...mission, problem: null } })).toMatchObject({ mission: { problem: null } });
    expect(validateEvent({ ...contact, kind: "sample", mission })).toEqual({ ...contact, kind: "sample", mission });
    expect(bad({ ...contact, kind: "sample", mission: { ...mission, problem: { ...problem, kind: "flaky" } } })).toContain("problem.kind must be one of");
    expect(bad({ ...contact, kind: "sample", mission: { ...mission, problem: { ...problem, source: "" } } })).toContain("bounded source");
    expect(bad({ ...contact, kind: "sample", mission: { ...mission, problem: { ...problem, retryAt: "soon" } } })).toContain("retryAt");
  });

  test("capacity and recovery waits", () => {
    expect(validateEvent({ ...base, kind: "capacity-wait", waiting: true })).toEqual({ ...base, kind: "capacity-wait", waiting: true });
    expect(bad({ ...base, kind: "capacity-wait" })).toContain("waiting must be a boolean");
    expect(bad({ ...contact, kind: "capacity-wait", waiting: false })).toContain("must not carry a contact");
    expect(validateEvent({ ...contact, kind: "recovery-wait", wait: "memory" })).toEqual({ ...contact, kind: "recovery-wait", wait: "memory" });
    expect(validateEvent({ ...contact, kind: "recovery-wait", wait: null })).toEqual({ ...contact, kind: "recovery-wait", wait: null });
    expect(bad({ ...contact, kind: "recovery-wait", wait: "queued" })).toContain("wait must be one of");
    expect(bad({ ...contact, kind: "recovery-wait" })).toContain("wait must be one of");
  });
});

test("queued and edited carry a known source", () => {
  const base = { v: 1, at: "2026-01-01T00:00:00.000Z", contact: "a" };
  expect(validateEvent({ ...base, kind: "queued", source: "seed" })).toMatchObject({ source: "seed" });
  expect(() => validateEvent({ ...base, kind: "queued", source: "someone" })).toThrow("source must be one of");
  expect(() => validateEvent({ ...base, kind: "edited", source: "model", fields: [] })).toThrow("fields");
  expect(() => validateEvent({ ...base, kind: "edited", fields: ["zone"] })).toThrow("source");
});
