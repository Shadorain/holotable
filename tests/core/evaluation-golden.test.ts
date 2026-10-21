import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { evaluateOperation, evaluationEvidence } from "../../src/core/evaluation.ts";
import { foldEvents } from "../../src/core/fold.ts";
import type { Event } from "../../src/core/types.ts";
import { ev, makeContact, makeMeasurements, makeOp, makeUsageEvidence, T0 } from "./fixtures.ts";

const MIN = 60_000;
const GOLDEN = new URL("./evaluation.golden.json", import.meta.url);
const launched = (at: number, ticket: string) => ev(at, ticket, "launched", { worktree: "/w", frontend: "orca", terminal: { handle: "h", incarnationId: "i" } });
const mission = (id: string, hold = "none", complete = false) => ({ id, hold, verify: null, complete });
const legacyUsage = (input: number, costUsd: number | null) => ({ tokens: { input, output: 1, cacheRead: 2, cacheWrite: 0 }, costUsd });
const bigUsage = (input: number, role = "worker") => ({ ...makeUsageEvidence(input), sources: [{ ...makeUsageEvidence(input).sources[0]!, role, id: `${role}:big` }] });

/** One operation touching every metric family and every recommendation rule. */
function fixture() {
  const work = ["a", "b", "c", "d", "e", "f"];
  const operation = makeOp([
    ...work.map(ticket => makeContact(ticket)),
    makeContact("g", { kind: "audit" }),
    makeContact("decide", { kind: "decision" }),
    makeContact("fix", { kind: "conflict" }),
  ], { auto: { enabled: true, land: false } } as never);
  const events: Event[] = [];
  for (const [i, ticket] of work.entries()) events.push(ev(i, ticket, "queued"));
  events.push(ev(0, "g", "queued"), ev(1, "g", "blocked", { by: ["a"] }), ev(1, "f", "blocked", { by: ["a"] }));
  for (const [i, ticket] of work.slice(0, 5).entries()) {
    const start = 5 * MIN + i * MIN;
    events.push(
      launched(start, ticket),
      ev(start, ticket, "socket-up", { generation: 1 }),
      ev(start + 1, ticket, "phase", { from: null, to: "plan" }),
      ev(start + 2, ticket, "sample", { workers: 2, mission: mission(`m-${ticket}`, "gate"), measurements: makeMeasurements({ recordedFailed: 3, repeatedFailedRevision: i, reviewFailures: i, recordedPassed: 1, latestActionable: 1, severity: { critical: 0, high: 1, medium: 0, low: 2 } }) }),
      ev(start + 3, ticket, "gate-armed", { gate: "plan" }),
      ev(start + 15 * MIN, ticket, "operator", { op: "approve", ok: true }),
      ev(start + 15 * MIN, ticket, "sample", { mission: mission(`m-${ticket}`), usageEvidence: bigUsage(10_000_000 * (i + 1)) }),
      ev(start + 16 * MIN, ticket, "phase", { from: "plan", to: "review" }),
      ev(start + 20 * MIN, ticket, "sample", { usageEvidence: bigUsage(40_000_000 * (i + 1), "review"), usage: legacyUsage(5, 0.5) }),
      ev(start + 21 * MIN, ticket, "socket-down"),
      ev(start + 23 * MIN, ticket, "socket-up", { generation: 2 }),
      ev(start + 25 * MIN, ticket, "phase", { from: "review", to: "complete" }),
      ev(start + 25 * MIN, ticket, "sample", { mission: mission(`m-${ticket}`, "none", true) }),
    );
    for (let attempt = 0; attempt < 2; attempt++) events.push(ev(start + 30 * MIN + attempt, ticket, "land-attempt", { outcome: attempt === 0 && i < 3 ? "conflict" : "clean" }));
    if (i < 4) events.push(ev(start + 40 * MIN, ticket, "landed", { via: "merge" }));
  }
  for (let r = 0; r < 6; r++) events.push(ev(50 * MIN + r, "e", "reaped"), launched(50 * MIN + r, "e"), ev(50 * MIN + r, "e", "launch-failed", { step: "spawn", error: "x" }));
  events.push(
    ev(60 * MIN, "f", "unblocked"), launched(61 * MIN, "f"),
    ev(62 * MIN, "f", "sample", { usage: legacyUsage(100, 1) }), ev(63 * MIN, "f", "sample", { usage: legacyUsage(300, 2) }),
    ev(64 * MIN, "f", "operator", { op: "resend", ok: true }),
    ev(65 * MIN, "decide", "pane-usage", { pane: "pane:0", tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.25, sessions: 1, malformedLines: 1 }),
    ev(66 * MIN, "gone", "pane-usage", { pane: "pane:0", tokens: { input: 9, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: null, sessions: 1, truncated: true }),
    ev(67 * MIN, "fix", "landed", { via: "merge" }),
  );
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // A late, out-of-order sample exercises the clock-anomaly path.
  events.push(ev(30, "a", "sample", { usageEvidence: null }));
  // Stall evidence, appended after the anomaly so earlier event indexes keep their meaning: a rate-limited
  // mission, an auto capacity wait and a Recovery deferral still open at the clock.
  events.push(
    ev(70 * MIN, "f", "sample", { mission: { ...mission("m-f", "quota"), problem: { kind: "rate-limit", source: "review", retryAt: null } } }),
    ev(70 * MIN, null, "capacity-wait", { waiting: true }),
    ev(72 * MIN, "e", "recovery-wait", { wait: "memory" }),
    ev(75 * MIN, "f", "sample", { mission: { ...mission("m-f"), problem: null } }),
    ev(75 * MIN, null, "capacity-wait", { waiting: false }),
  );
  return { operation, events };
}

function payload() {
  const { operation, events } = fixture();
  const derived = foldEvents(events);
  const open = evaluateOperation(operation, derived, T0 + 90 * MIN);
  const closedEvents = [...events, ev(80 * MIN, null, "closed", { outcome: "abandoned" })];
  const closed = evaluateOperation(operation, foldEvents(closedEvents), T0 + 200 * MIN);
  // Without churn and accounting gaps, only the waiting and phase-cost rules fire (approval, delivery, dependency, phase cost).
  const noisy: Record<string, true> = { "land-attempt": true, reaped: true, "launch-failed": true, "pane-usage": true };
  const quietEvents = events
    .filter(e => !noisy[e.kind] && !(e.kind === "sample" && e.usageEvidence === null))
    .filter(e => !(e.kind === "launched" && Date.parse(e.at) >= T0 + 50 * MIN))
    .map(e => e.kind === "sample" ? { ...e, measurements: undefined, usage: undefined } : e);
  const quiet = evaluateOperation(operation, foldEvents(quietEvents), T0 + 90 * MIN);
  return { open, evidence: evaluationEvidence(operation, derived, T0 + 90 * MIN), closed, quiet };
}

test("the intel payload for a representative operation is unchanged", () => {
  const actual = JSON.stringify(payload(), null, 1) + "\n";
  if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, actual);
  expect(actual).toBe(readFileSync(GOLDEN, "utf8"));
});
