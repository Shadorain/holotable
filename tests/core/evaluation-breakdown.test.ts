import { expect, test } from "bun:test";
import { evaluateOperation, evaluationEvidence, parseEvaluation, type Evaluation } from "../../src/core/evaluation.ts";
import { foldEvents } from "../../src/core/fold.ts";
import type { Contact, Event, Hold, Operation, UsageEvidence } from "../../src/core/types.ts";
import { ev, makeContact, makeMeasurements, makeOp, T0 } from "./fixtures.ts";

const M = 60_000;
const H = 60 * M;
const launched = (at: number, ticket: string) => ev(at, ticket, "launched", { worktree: "/w", frontend: "orca", terminal: { handle: ticket, incarnationId: `${ticket}-${at}` } });
const op = (at: number, ticket: string, name: string, extra: Record<string, unknown> = {}) => ev(at, ticket, "operator", { op: name, ok: true, ...extra });
const hold = (at: number, ticket: string, value: Hold, extra: Record<string, unknown> = {}) =>
  ev(at, ticket, "sample", { mission: { id: `m-${ticket}`, hold: value, verify: null, complete: false }, ...extra });
/** One scoped source per contact so each owns its spend. */
function scoped(ticket: string, input: number, costUsd: number, unpricedMessages = 0): UsageEvidence {
  return {
    v: 1, measuredAt: new Date(T0).toISOString(), missing: 0, unsupportedWorkers: 0, malformedLines: 0, resets: 0, backlogBytes: 0, partial: false,
    sources: [{ role: "coordinator", id: `session-${ticket}`, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd, sessions: 1, pricedMessages: 1, unpricedMessages }],
  };
}
function evaluate(contacts: Contact[], events: Event[], now: number, overrides: Partial<Operation> = {}): Evaluation {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return evaluateOperation(makeOp(contacts, overrides), foldEvents(sorted), T0 + now);
}

test("operator waits split by kind and by who resolved them, with open waits pending", () => {
  const contacts = [makeContact("p"), makeContact("q"), makeContact("r"), makeContact("d", { kind: "decision" })];
  const events = [
    ...["p", "q", "r", "d"].map(ticket => ev(0, ticket, "queued")),
    // r: launched by the lander (no launch action of its own), reaped after a minute.
    launched(3 * M, "r"), ev(4 * M, "r", "reaped"),
    // d: the decision agent decides after 5 minutes.
    ev(5 * M, "d", "decided", { choice: "x", by: "agent" }), ev(5 * M, "d", "landed", { via: "manual" }),
    // p: auto launch, auto plan approval, operator answer and gate approval, auto land.
    launched(10 * M, "p"), op(10 * M + 1, "p", "launch", { by: "auto" }),
    hold(11 * M, "p", "plan-approval"), op(15 * M, "p", "plan-approve", { by: "auto" }), hold(15 * M, "p", "none"),
    hold(16 * M, "p", "question"), op(18 * M, "p", "answer"), hold(18 * M, "p", "none"),
    hold(20 * M, "p", "gate"), op(26 * M, "p", "approve"), hold(26 * M, "p", "none"),
    ev(30 * M, "p", "phase", { from: null, to: "complete" }),
    ev(40 * M, "p", "landed", { via: "merge" }), op(40 * M + 5, "p", "land", { by: "auto" }),
    // q: operator launch and plan approval, then complete and never landed.
    launched(20 * M, "q"), op(20 * M, "q", "launch"),
    hold(21 * M, "q", "plan-approval"), op(31 * M, "q", "plan-approve"), hold(31 * M, "q", "none"),
    ev(35 * M, "q", "phase", { from: null, to: "complete" }),
  ];
  const result = evaluate(contacts, events, 60 * M);
  expect(result.operatorWait).toEqual({
    operatorMs: 41 * M, automationMs: 29 * M, pendingMs: 25 * M, waits: 10, missionMs: 14 * M,
    byKind: {
      launch: { operatorMs: 23 * M, automationMs: 10 * M, pendingMs: 0, waits: 3 },
      decision: { operatorMs: 0, automationMs: 5 * M, pendingMs: 0, waits: 1 },
      "plan-approval": { operatorMs: 10 * M, automationMs: 4 * M, pendingMs: 0, waits: 2 },
      gate: { operatorMs: 6 * M, automationMs: 0, pendingMs: 0, waits: 1 },
      question: { operatorMs: 2 * M, automationMs: 0, pendingMs: 0, waits: 1 },
      land: { operatorMs: 0, automationMs: 10 * M, pendingMs: 25 * M, waits: 2 },
    },
  });
  const byTicket = Object.fromEntries(result.contacts!.map(contact => [contact.ticket, contact]));
  expect(byTicket.p!.waitMs).toEqual({ operator: 8 * M, automation: 24 * M, pending: 0 });
  expect(byTicket.q!.state).toBe("complete");
  expect(byTicket.r!.state).toBe("reaped");
  expect(byTicket.r!.outcome).toBe("abandoned");
  expect(byTicket.d!.outcome).toBe("landed");
  // Launched live time (p 30, q 40, r 1 min) is mission time plus every post-launch wait.
  const wait = result.operatorWait!;
  const prelaunch = [wait.byKind.launch!, wait.byKind.decision!].reduce((total, row) => total + row.operatorMs + row.automationMs + row.pendingMs, 0);
  expect(result.contacts!.reduce((total, contact) => total + contact.activeMs, 0)).toBe(71 * M);
  expect(wait.missionMs + wait.operatorMs + wait.automationMs + wait.pendingMs - prelaunch).toBe(71 * M);

  // Closing the operation ends q's wait without a resolver: the operator never landed it.
  const closed = evaluate(contacts, [...events, ev(70 * M, null, "closed", { outcome: "abandoned" })], 100 * M);
  expect(closed.operatorWait!.byKind.land).toEqual({ operatorMs: 35 * M, automationMs: 10 * M, pendingMs: 0, waits: 2 });
  expect(closed.contacts!.find(contact => contact.ticket === "q")!.outcome).toBe("abandoned");
});

test("contact breakdown: lifecycle, blockers before and after launch, relaunch actors, conflicts, review rounds", () => {
  const contacts = [makeContact("x"), makeContact("y", { blockedBy: ["x"] }), makeContact("h", { kind: "conflict" })];
  const measured = (at: number, completedRounds: number, findingOccurrences: number, latestActionable: number, latestRejected: number, reviewFailures: number) =>
    hold(at, "x", "none", { measurements: makeMeasurements({ completedRounds, findingOccurrences, latestActionable, latestRejected, reviewFailures }) });
  const refused = (at: number, error: string) => ev(at, "x", "operator", { op: "relaunch", ok: false, error, by: "recover" });
  const events = [
    ev(0, "x", "queued"), ev(0, "y", "queued"), ev(0, "y", "blocked", { by: ["x"] }),
    launched(1 * M, "x"), op(1 * M, "x", "launch"),
    launched(6 * M, "x"), op(6 * M, "x", "relaunch"),
    refused(7 * M, "memory-pressure: 1.2 GiB free"), refused(7 * M, "refused: cap 4/4"), refused(7 * M, "refused: pane in the way"), refused(7 * M, "gave up: 3 relaunches in 30 min"),
    launched(8 * M, "x"), op(8 * M, "x", "relaunch", { by: "recover" }),
    launched(9 * M, "x"),
    measured(10 * M, 1, 4, 3, 1, 1), measured(20 * M, 3, 9, 2, 0, 2),
    ev(30 * M, "x", "land-attempt", { outcome: "conflict", paths: ["src/a.ts", "src/b.ts"] }),
    ev(30 * M, "h", "queued", { source: "conflict" }), launched(30 * M, "h"), ev(31 * M, "h", "landed", { via: "merge" }),
    ev(31 * M, "x", "land-attempt", { outcome: "conflict", paths: ["src/a.ts"] }),
    ev(32 * M, "x", "land-attempt", { outcome: "clean" }), ev(32 * M, "x", "landed", { via: "merge" }),
    ev(32 * M, "y", "unblocked"), launched(33 * M, "y"),
    ev(34 * M, "y", "blocked", { by: ["z"] }), ev(40 * M, "y", "unblocked"),
    ev(50 * M, "y", "land-attempt", { outcome: "conflict" }),
  ];
  const result = evaluate(contacts, events, 60 * M);
  const [x, y, h] = result.contacts!;
  expect(x).toMatchObject({
    ticket: "x", kind: "implement", state: "landed", outcome: "landed",
    queuedAt: T0, launchedAt: T0 + M, landedAt: T0 + 32 * M, endedAt: T0 + 32 * M, leadMs: 32 * M, activeMs: 31 * M,
    relaunches: { total: 3, operator: 1, recovery: 1, auto: 0, other: 1 },
    conflicts: { count: 2, landAttempts: 3, paths: ["src/a.ts", "src/b.ts"] },
    review: {
      rounds: 3, findings: 9, failures: 2,
      perRound: [{ at: T0 + 10 * M, rounds: 1, findings: 4, actionable: 3, rejected: 1 }, { at: T0 + 20 * M, rounds: 2, findings: 5, actionable: 2, rejected: 0 }],
    },
  });
  expect(y).toMatchObject({
    state: "running", outcome: "open", leadMs: null, activeMs: 27 * M, review: null,
    blockedMs: { beforeLaunch: 32 * M, afterLaunch: 6 * M, by: { x: 32 * M, z: 6 * M } },
    conflicts: { count: 1, landAttempts: 1, paths: [] },
  });
  expect(h).toMatchObject({ kind: "conflict", state: "landed", outcome: "landed", activeMs: M });
  expect(result.stalls!.launchRefusals).toEqual({ memory: 1, sessionCap: 1, refused: 1, gaveUp: 1 });
  expect(result.conflicts).toEqual({
    rate: 0.75, unpathed: 1, truncated: false,
    paths: [{ path: "src/a.ts", conflicts: 2, contacts: ["x"] }, { path: "src/b.ts", conflicts: 1, contacts: ["x"] }],
    contacts: [{ ticket: "x", conflicts: 2, landAttempts: 3 }, { ticket: "y", conflicts: 1, landAttempts: 1 }],
  });
  expect(result.series).toEqual({
    bucketMs: H, truncated: false,
    buckets: [
      { at: T0, launches: 6, deliveries: 1, landAttempts: 4, conflicts: 3, reviewFailures: 2 },
      { at: T0 + H, launches: 0, deliveries: 0, landAttempts: 0, conflicts: 0, reviewFailures: 0 },
    ],
  });
  expect(parseEvaluation(JSON.parse(JSON.stringify(result)))).toEqual(JSON.parse(JSON.stringify(result)));
});

test("throughput per active hour excludes stretches with nothing queued or live; series widen and truncate", () => {
  const contacts = [makeContact("a"), makeContact("b")];
  const events = [
    ev(0, "a", "queued"), launched(M, "a"), ev(2 * M, "a", "landed", { via: "merge" }),
    ev(3 * H, "b", "queued"), launched(3 * H + M, "b"), ev(3 * H + 2 * M, "b", "landed", { via: "merge" }),
  ];
  const result = evaluate(contacts, events, 5 * H);
  expect(result.activity).toEqual({ activeMs: 4 * M, idleMs: 5 * H - 4 * M, deliveriesPerActiveHour: 30 });
  expect(result.throughputPerHour).toBe(0.4);
  expect(result.series!.bucketMs).toBe(H);
  expect(result.series!.buckets.map(bucket => bucket.deliveries)).toEqual([1, 0, 0, 1, 0, 0]);

  const days = evaluate(contacts, events, 10 * 24 * H).series!;
  expect(days.bucketMs).toBe(24 * H);
  expect(days.buckets).toHaveLength(11);
  expect(days.buckets[0]!.deliveries).toBe(2);

  // Four years of weeks exceed 168 buckets: the oldest (holding both deliveries) drop.
  const weeks = evaluate(contacts, events, 4 * 365 * 24 * H).series!;
  expect(weeks.bucketMs).toBe(7 * 24 * H);
  expect(weeks.truncated).toBe(true);
  expect(weeks.buckets).toHaveLength(168);
  expect(weeks.buckets.reduce((total, bucket) => total + bucket.deliveries, 0)).toBe(0);
});

test("spend splits known cost by outcome, keeps panes as waste and reports coverage shares", () => {
  const contacts = ["L", "A", "O"].map(ticket => makeContact(ticket)).concat(makeContact("C", { kind: "conflict" }), makeContact("dec", { kind: "decision" }));
  const sample = (ticket: string, input: number, costUsd: number, unpriced = 0) => ev(1, ticket, "sample", { usageEvidence: scoped(ticket, input, costUsd, unpriced) });
  const events = [
    ...["L", "A", "O", "C"].map(ticket => launched(0, ticket)),
    sample("L", 300, 3), sample("A", 200, 2), sample("O", 100, 1, 1), sample("C", 50, 0.5),
    ev(5, "A", "reaped"), ev(6, "C", "landed", { via: "merge" }), ev(10, "L", "landed", { via: "merge" }),
    ev(11, "dec", "pane-usage", { pane: "pane:0", tokens: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.25, sessions: 1 }),
  ];
  const result = evaluate(contacts, events, 100);
  expect(result.usage.knownCostUsd).toBe(6.75);
  expect(result.usage.partial).toBe(true);
  expect(result.usage.spend).toEqual({
    landedUsd: 3, landedPriced: 1, perLandedUsd: 3, supportUsd: 0.5, openUsd: 1, abandonedUsd: 2, paneUsd: 0.25, wastedUsd: 2.25,
    knownShare: 0.75, pricedShare: 0.8,
  });
  const spend = Object.fromEntries(result.contacts!.map(contact => [contact.ticket, contact.spend]));
  expect(spend).toEqual({
    L: { tokens: 300, costUsd: 3, complete: true }, A: { tokens: 200, costUsd: 2, complete: true },
    O: { tokens: 100, costUsd: 1, complete: false }, C: { tokens: 50, costUsd: 0.5, complete: true },
    dec: { tokens: 25, costUsd: 0.25, complete: true },
  });
});

test("logs without recorded problems or board waits count quota holds and nothing else", () => {
  const events = [
    launched(0, "a"), ev(0, "a", "socket-up", { generation: 1 }),
    hold(10 * M, "a", "quota"), hold(25 * M, "a", "none"), hold(30 * M, "a", "quota", { measurements: makeMeasurements({ reviewFailures: 2 }) }),
    ev(32 * M, "a", "socket-down"), ev(35 * M, "a", "socket-down"), ev(36 * M, "a", "socket-up", { generation: 2 }),
  ];
  const stalls = evaluate([makeContact("a")], events, 40 * M).stalls!;
  expect(stalls.quota).toEqual({ ms: 25 * M, episodes: 2 });
  expect(stalls.offline).toEqual({ ms: 4 * M, episodes: 1 });
  expect(stalls.rateLimit).toEqual({ ms: 0, episodes: 0 });
  expect(stalls.otherProblem).toEqual({ ms: 0, episodes: 0 });
  expect(stalls.capacityWait).toEqual({ ms: 0, episodes: 0 });
  expect(stalls.recoveryDeferral).toEqual({ ms: 0, episodes: 0, byKind: { capacity: 0, memory: 0, refused: 0 } });
  expect(stalls.reviewFailures).toBe(2);
  expect(stalls.caveat).toContain("carry no problem");
});

test("stalls split recorded problems by kind and time capacity waits and recovery deferrals", () => {
  const problem = (kind: string) => ({ kind, source: "review", retryAt: null });
  const events = [
    launched(0, "a"), ev(0, "a", "socket-up", { generation: 1 }), launched(0, "b"),
    hold(5 * M, "a", "quota", { mission: { id: "m-a", hold: "quota", verify: null, complete: false, problem: problem("quota") } }),
    // A rate limit under the same quota hold is its own stall, not more quota.
    hold(10 * M, "a", "quota", { mission: { id: "m-a", hold: "quota", verify: null, complete: false, problem: problem("rate-limit") } }),
    hold(20 * M, "a", "none", { mission: { id: "m-a", hold: "none", verify: null, complete: false, problem: null } }),
    hold(25 * M, "a", "blocked", { mission: { id: "m-a", hold: "blocked", verify: null, complete: false, problem: problem("timeout") } }),
    hold(28 * M, "a", "blocked", { mission: { id: "m-a", hold: "blocked", verify: null, complete: false, problem: problem("error") } }),
    hold(30 * M, "a", "none", { mission: { id: "m-a", hold: "none", verify: null, complete: false, problem: null } }),
    hold(32 * M, "a", "quota", { mission: { id: "m-a", hold: "quota", verify: null, complete: false, problem: problem("rate-limit") } }),
    ev(12 * M, null, "capacity-wait", { waiting: true }), ev(13 * M, null, "capacity-wait", { waiting: true }),
    ev(18 * M, null, "capacity-wait", { waiting: false }), ev(35 * M, null, "capacity-wait", { waiting: true }),
    ev(10 * M, "b", "recovery-wait", { wait: "capacity" }), ev(14 * M, "b", "recovery-wait", { wait: "memory" }),
    ev(20 * M, "b", "recovery-wait", { wait: null }), ev(30 * M, "b", "recovery-wait", { wait: "refused" }),
  ];
  const contacts = [makeContact("a"), makeContact("b")];
  const stalls = evaluate(contacts, events, 40 * M).stalls!;
  expect(stalls.quota).toEqual({ ms: 5 * M, episodes: 1 });
  expect(stalls.rateLimit).toEqual({ ms: 18 * M, episodes: 2 });
  expect(stalls.otherProblem).toEqual({ ms: 5 * M, episodes: 1 });
  expect(stalls.capacityWait).toEqual({ ms: 11 * M, episodes: 2 });
  expect(stalls.recoveryDeferral).toEqual({ ms: 20 * M, episodes: 2, byKind: { capacity: 4 * M, memory: 6 * M, refused: 10 * M } });
  // Closing the operation ends an open capacity wait at the close.
  const closed = evaluate(contacts, [...events, ev(38 * M, null, "closed", { outcome: "abandoned" })], 100 * M).stalls!;
  expect(closed.capacityWait).toEqual({ ms: 9 * M, episodes: 2 });
  expect(closed.rateLimit).toEqual({ ms: 16 * M, episodes: 2 });
});

test("waiting and delivery advice outranks accounting and churn under the six-rule cap", () => {
  const work = ["a", "b", "c"], blocked = ["g1", "g2", "g3"];
  const contacts = [...work, "r", ...blocked].map(ticket => makeContact(ticket));
  const events: Event[] = [];
  for (const ticket of work) {
    events.push(
      launched(0, ticket), hold(0, ticket, "gate"), hold(20 * M, ticket, "none"),
      ev(20 * M, ticket, "phase", { from: null, to: "complete" }), ev(40 * M, ticket, "landed", { via: "merge" }),
    );
  }
  events.push(hold(1, "a", "gate", { measurements: makeMeasurements({ recordedFailed: 3, repeatedFailedRevision: 2, reviewFailures: 3 }), usageEvidence: null }));
  for (let i = 0; i < 5; i++) events.push(ev(30 * M + i, "a", "land-attempt", { outcome: i < 4 ? "conflict" : "clean" }));
  for (let i = 0; i < 10; i++) events.push(launched(i, "r"));
  for (const ticket of blocked) events.push(ev(0, ticket, "queued"), ev(0, ticket, "blocked", { by: ["a"] }));
  const sorted = [...events].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  const operation = makeOp(contacts);
  const derived = foldEvents(sorted);
  const result = evaluateOperation(operation, derived, T0 + 60 * M);
  // Stakes: blocked 3×60 min, gates 3×20 min, ready-to-land 3×20 min, a live 40 min; the rest put nothing measurable at stake.
  expect(result.recommendations.map(rule => [rule.id, rule.impact!.scoreMs])).toEqual([
    ["dependency-wait", 180 * M], ["approval-wait", 60 * M], ["delivery-wait", 60 * M], ["repeat-verification", 40 * M],
    ["usage-coverage", 0], ["review-retries", 0],
  ]);
  // Four conflicts: the latest three are cited, newest first.
  const conflictIndexes = sorted.flatMap((event, index) => event.kind === "land-attempt" && event.outcome === "conflict" ? [index] : []);
  expect(evaluationEvidence(operation, derived, T0 + 60 * M).conflictEvents.map(row => row.index)).toEqual(conflictIndexes.slice(1).reverse());
});

test("archived evaluations validate new fields when present and stay valid without them", () => {
  const result = JSON.parse(JSON.stringify(evaluate([makeContact("a")], [ev(0, "a", "queued"), launched(M, "a")], 2 * M)));
  expect(parseEvaluation(result)).toEqual(result);
  const { contacts: _c, operatorWait: _w, activity: _a, series: _s, stalls: _t, conflicts: _x, ...legacy } = result;
  const { spend: _spend, ...usage } = legacy.usage;
  expect(parseEvaluation({ ...legacy, usage })).not.toBeNull();
  const { rateLimit: _r, otherProblem: _o, capacityWait: _cw, recoveryDeferral: _rd, ...stalls } = result.stalls;
  expect(parseEvaluation({ ...result, stalls })).not.toBeNull();
  const broken = [
    { contacts: [{ ...result.contacts[0], state: "lost" }] },
    { operatorWait: { ...result.operatorWait, byKind: { nap: result.operatorWait.byKind.launch } } },
    { series: { ...result.series, buckets: Array.from({ length: 169 }, () => result.series.buckets[0]) } },
    { stalls: { ...result.stalls, quota: { ms: -1, episodes: 0 } } },
    { stalls: { ...result.stalls, rateLimit: { ms: 1 } } },
    { stalls: { ...result.stalls, recoveryDeferral: { ...result.stalls.recoveryDeferral, byKind: { capacity: 0 } } } },
    { conflicts: { ...result.conflicts, rate: Infinity } },
    { usage: { ...result.usage, spend: { ...result.usage.spend, landedPriced: 0.5 } } },
    { activity: { ...result.activity, deliveriesPerActiveHour: -1 } },
  ];
  for (const fields of broken) expect(parseEvaluation({ ...result, ...fields })).toBeNull();
});
