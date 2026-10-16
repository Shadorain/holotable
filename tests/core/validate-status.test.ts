import { describe, expect, test } from "bun:test";
import { validateStatus } from "../../src/core/validate-status.ts";
import { makeStatus, makeMeasurements, makeUsageEvidence } from "./fixtures.ts";
import { missionProblem } from "../../src/core/mission-problem.ts";
import type { MissionCheck } from "../../src/core/types.ts";

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

describe("validateStatus check", () => {
  const check: MissionCheck = { at: "2026-10-15T20:00:00.000Z", state: "threads", detail: "2 unresolved review threads", conflicts: [], threads: { open: 2, total: 3 } };

  test("older producers omit it; a valid check is kept", () => {
    expect(validateStatus(makeStatus()).check).toBeUndefined();
    expect(validateStatus({ ...makeStatus(), check }).check).toEqual(check);
    expect(validateStatus({ ...makeStatus(), check: null }).check).toBeNull();
  });

  test("a check with an unknown state or more open threads than total is invalid", () => {
    expect(() => validateStatus({ ...makeStatus(), check: { ...check, state: "ok" } })).toThrow();
    expect(() => validateStatus({ ...makeStatus(), check: { ...check, threads: { open: 4, total: 3 } } })).toThrow();
    expect(() => validateStatus({ ...makeStatus(), check: { ...check, conflicts: [1] } })).toThrow();
  });
});

test("malformed optional evaluation groups become unknown without removing valid mission controls",()=>{
 const legacy=validateStatus(makeStatus({actions:["approve"]}));
 expect(legacy.measurements).toBeUndefined();expect(legacy.usageEvidence).toBeUndefined();
 for(const bad of [{v:2},null,"bad",[]]){
  const parsed=validateStatus({...makeStatus({actions:["approve"]}),measurements:bad,usageEvidence:bad});
  expect(parsed.measurements).toBeNull();expect(parsed.usageEvidence).toBeNull();expect(parsed.actions).toEqual(["approve"]);
 }
 const m=makeMeasurements(),u=makeUsageEvidence(4);
 expect(validateStatus({...makeStatus(),measurements:m,usageEvidence:u})).toMatchObject({measurements:m,usageEvidence:u});
});

test("non-string optional enum values cannot throw away valid controls",()=>{
 const m=makeMeasurements(),u=makeUsageEvidence(4),invalid={toString:null};
 const parsed=validateStatus({...makeStatus({actions:["approve"]}),measurements:{...m,config:{...m.config,graph:invalid}},usageEvidence:{...u,sources:[{...u.sources[0],role:invalid}]}});
 expect(parsed.measurements).toBeNull();expect(parsed.usageEvidence).toBeNull();expect(parsed.actions).toEqual(["approve"]);
});

describe("validateStatus review/model", () => {
  const review = { startedAt: "2026-10-16T00:00:00.000Z", deadlineAt: "2026-10-16T00:05:00.000Z", active: 1, completed: 0, total: 3, models: ["p/m"] };

  test("older producers omit them; valid values are kept", () => {
    const s = validateStatus(makeStatus());
    expect(s.review).toBeUndefined();
    expect(s.model).toBeUndefined();
    const parsed = validateStatus({ ...makeStatus(), review, model: "p/m" });
    expect(parsed.review).toEqual(review);
    expect(parsed.model).toBe("p/m");
    const cleared = validateStatus({ ...makeStatus(), review: null, model: null });
    expect(cleared.review).toBeNull();
    expect(cleared.model).toBeNull();
  });

  test("malformed review cannot enter the board", () => {
    expect(() => validateStatus({ ...makeStatus(), review: { ...review, deadlineAt: "soon" } })).toThrow();
    expect(() => validateStatus({ ...makeStatus(), review: { ...review, active: -1 } })).toThrow();
    expect(() => validateStatus({ ...makeStatus(), review: { ...review, models: "p/m" } })).toThrow();
    expect(() => validateStatus({ ...makeStatus(), model: 42 })).toThrow();
  });
});
