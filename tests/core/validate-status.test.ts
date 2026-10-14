import { describe, expect, test } from "bun:test";
import { validateStatus } from "../../src/core/validate-status.ts";
import { makeStatus } from "./fixtures.ts";
import { missionProblem } from "../../src/core/mission-problem.ts";

const bad = (v: unknown): string => {
  try {
    validateStatus(v);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("validateStatus", () => {
  test("accepts a full status and preserves fields", () => {
    const s = validateStatus(makeStatus());
    expect(s.phase).toBe("work");
    expect(s.ctl?.socket).toBe("/tmp/x.sock");
  });


  test("rejects wrong schema and missing required fields", () => {
    expect(bad({ ...makeStatus(), schema: 2 })).toContain("schema must be 1");
    const noHold = { ...makeStatus() } as Record<string, unknown>;
    delete noHold.hold;
    expect(bad(noHold)).toContain("hold must be one of");
    expect(bad({ ...makeStatus(), actions: "approve" })).toContain("actions must be");
    expect(bad({ ...makeStatus(), complete: "yes" })).toContain("complete must be");
    expect(bad({ ...makeStatus(), progress: { step: 1 } })).toContain("progress");
    expect(bad({ ...makeStatus(), gate: { kind: "pause" } })).toContain("gate");
    expect(bad({ ...makeStatus(), ctl: { socket: "/x" } })).toContain("ctl");
    expect(bad({ ...makeStatus(), hold: "weird" })).toContain("hold must be one of");
  });

  test("unknown fields are ignored", () => {
    const s = validateStatus({ ...makeStatus(), extra: { deep: true } });
    expect("extra" in s).toBe(false);
  });
});

test("explicitly healthy status clears an older error description, while absent metadata still reports it", () => {
  const old = makeStatus({ phase: "review", next: "Review failed: Reviewer error: 429 rate_limit_error" });
  expect(missionProblem(validateStatus(old))?.kind).toBe("rate-limit");
  expect(missionProblem(validateStatus({ ...old, problem: null }))).toBeNull();
});

test("malformed retry metadata cannot enter the board", () => {
  const problem = { kind: "rate-limit", source: "review", detail: "429 rate_limit_error", retryAt: "not a date", attempt: 1, completed: 0, total: 2 };
  expect(() => validateStatus({ ...makeStatus(), problem })).toThrow();
  expect(() => validateStatus({ ...makeStatus(), problem: { ...problem, retryAt: null, attempt: -1 } })).toThrow();
});
