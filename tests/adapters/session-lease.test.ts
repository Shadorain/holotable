import { expect, test } from "bun:test";
import { probeSessionLease } from "../../src/adapters/session-lease.ts";

test("lease diagnostics cannot treat ambiguous, foreign or malformed evidence as ownership", async () => {
  const sessionId = "isolated-session";
  for (const [raw, expected] of [
    [{ held: [sessionId], unknown: [] }, "held"],
    [{ held: [], unknown: [] }, "not-held"],
    [{ held: [], unknown: [sessionId] }, "unknown"],
    [{ held: [sessionId], unknown: [sessionId] }, "unknown"],
    [{ held: ["another-session"], unknown: [] }, "unknown"],
    [{ held: [] }, "unknown"],
  ] as const) {
    const report = await probeSessionLease(async () => ({ code: 0, stdout: JSON.stringify(raw), stderr: "" }), sessionId, "/isolated", "ssh:test");
    expect(report.state).toBe(expected);
    expect(report.sessionId).toBe(sessionId);
    expect(report.host).toBe("ssh:test");
  }
});

test("a failed native lease probe stays unknown rather than freeing a session", async () => {
  const report = await probeSessionLease(async () => { throw new Error("host disconnected"); }, "isolated-session", "/isolated", "ssh:test");
  expect(report.state).toBe("unknown");
  expect(report.detail).toBe("host disconnected");
});
