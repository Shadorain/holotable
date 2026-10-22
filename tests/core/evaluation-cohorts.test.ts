import { expect, test } from "bun:test";
import { evaluateOperation, parseEvaluation, type Evaluation } from "../../src/core/evaluation.ts";
import { foldEvents } from "../../src/core/fold.ts";
import type { Event, UsageEvidence } from "../../src/core/types.ts";
import { ev, makeContact, makeMeasurements, makeOp, T0 } from "./fixtures.ts";

const M = 60_000;
const H = 60 * M;
const launched = (at: number, ticket: string) => ev(at, ticket, "launched", { worktree: "/w", frontend: "orca", terminal: { handle: ticket, incarnationId: `${ticket}-${at}` } });
/** One scoped source per contact so each owns its spend. */
function scoped(ticket: string, costUsd: number): UsageEvidence {
  return {
    v: 1, measuredAt: new Date(T0).toISOString(), missing: 0, unsupportedWorkers: 0, malformedLines: 0, resets: 0, backlogBytes: 0, partial: false,
    sources: [{ role: "coordinator", id: `session-${ticket}`, tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd, sessions: 1, pricedMessages: 1, unpricedMessages: 0 }],
  };
}

/**
 * `count` work contacts launched an hour apart, each landing 30 minutes after its first launch. Churning contacts
 * relaunch four times, fail review five times and cost $100; the rest launch once, review cleanly and cost $10.
 */
function operation(count: number, churns: (index: number) => boolean): Evaluation {
  const tickets = Array.from({ length: count }, (_, i) => `c${i}`);
  const events: Event[] = [];
  for (const [i, ticket] of tickets.entries()) {
    const start = i * H, churn = churns(i);
    events.push(ev(0, ticket, "queued"), launched(start, ticket));
    if (churn) for (let k = 1; k <= 4; k++) events.push(launched(start + k * M, ticket), ev(start + k * M, ticket, "launch-failed", { step: "spawn", error: "x" }));
    events.push(
      ev(start + 10 * M, ticket, "sample", {
        mission: { id: `m-${ticket}`, hold: "none", verify: null, complete: true },
        usageEvidence: scoped(ticket, churn ? 100 : 10),
        measurements: makeMeasurements({ completedRounds: churn ? 4 : 1, reviewFailures: churn ? 5 : 0 }),
      }),
      ev(start + 30 * M, ticket, "land-attempt", { outcome: "clean" }),
      ev(start + 30 * M, ticket, "landed", { via: "merge" }),
    );
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return evaluateOperation(makeOp(tickets.map(ticket => makeContact(ticket))), foldEvents(events), T0 + count * H);
}

const ids = (e: Evaluation) => e.recommendations.map(rule => rule.id);

test("churn fixed long ago shows as an early-vs-recent drop instead of firing count rules", () => {
  const e = operation(9, i => i < 3);
  // Cumulatively 12 of 21 launches were relaunches and three runs failed review five times, all in the early third.
  expect(e.attempts.relaunches).toBe(12);
  expect(ids(e)).not.toContain("relaunch-churn");
  expect(ids(e)).not.toContain("review-retries");
  const { early, recent } = e.launchCohorts!;
  expect([early.n, recent.n]).toEqual([3, 3]);
  expect(early.firstLaunchAt).toBe(T0);
  expect(recent.firstLaunchAt).toBe(T0 + 6 * H);
  expect([early.relaunchesPerContact, recent.relaunchesPerContact]).toEqual([4, 0]);
  expect([early.launchFailuresPerContact, recent.launchFailuresPerContact]).toEqual([4, 0]);
  expect([early.medianUsd, recent.medianUsd]).toEqual([100, 10]);
  expect([early.reviewRoundsPerContact, recent.reviewRoundsPerContact]).toEqual([4, 1]);
  expect(recent.medianDeliveryMs).toBe(30 * M);
  expect(recent.conflictsPerLandAttempt).toBe(0);
});

test("churn in the recent window still fires, judged on that window", () => {
  const e = operation(9, i => i >= 6);
  expect(e.launchCohorts!.recent.relaunchesPerContact).toBe(4);
  const churn = e.recommendations.find(rule => rule.id === "relaunch-churn")!;
  expect([churn.evidence.numerator, churn.evidence.denominator]).toEqual([12, 15]);
  expect(churn.ruleVersion).toBe(2);
  expect(ids(e)).toContain("review-retries");
});

test("without a cohort of three per third the whole history is judged", () => {
  const e = operation(8, i => i < 3);
  expect(e.launchCohorts).toBeNull();
  expect(ids(e)).toContain("relaunch-churn");
});

test("stored launch cohorts round-trip and are validated", () => {
  const e = JSON.parse(JSON.stringify(operation(9, i => i < 3)));
  expect(parseEvaluation(e)).toEqual(e);
  expect(parseEvaluation({ ...e, launchCohorts: null })).not.toBeNull();
  const { launchCohorts: _, ...archived } = e;
  expect(parseEvaluation(archived)).not.toBeNull();
  for (const broken of [{ ...e.launchCohorts.early, n: 1.5 }, { ...e.launchCohorts.early, medianUsd: -1 }, { ...e.launchCohorts.early, reviewed: undefined }]) {
    expect(parseEvaluation({ ...e, launchCohorts: { ...e.launchCohorts, early: broken } })).toBeNull();
  }
});
