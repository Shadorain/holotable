import { describe, expect, test } from "bun:test";
import { validateStatus } from "../../src/core/validate-status.ts";
import { makeStatus } from "./fixtures.ts";

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

  test("error prefix", () => {
    expect(bad(null)).toBe("Invalid status at status.json: expected a JSON object");
    expect(bad({})).toContain("Invalid status at status.json");
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
