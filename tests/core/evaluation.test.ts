import { expect, test } from "bun:test";
import { evaluateOperation, parseEvaluation, parseMeasurements, parseUsageEvidence, recommendEvaluation, evaluationEvidence } from "../../src/core/evaluation.ts";
import { foldEvents } from "../../src/core/fold.ts";
import { buildReport } from "../../src/core/report.ts";
import type { Event } from "../../src/core/types.ts";
import { ev, iso, makeContact, makeOp, T0, makeMeasurements as measurements, makeUsageEvidence as usage } from "./fixtures.ts";
import { validateEvent } from "../../src/core/validate-event.ts";

const launched = (at: number, ticket = "a") => ev(at, ticket, "launched", { worktree: "/w", frontend: "orca", terminal: { handle: "h", incarnationId: "i" } });

test("finished queue latency is separate from unfinished ages and non-work delivery", () => {
  const op = makeOp([makeContact("a"), makeContact("b"), makeContact("decision", { kind: "decision" }), makeContact("conflict", { kind: "conflict" })]);
  const events = [ev(0, "a", "queued"), ev(0, "b", "queued"), launched(10), ev(40, "a", "phase", { from: null, to: "complete" }), ev(50, "a", "landed", { via: "merge" }), ev(5, "decision", "landed", { via: "manual" }), ev(6, "conflict", "landed", { via: "merge" })];
  const result = evaluateOperation(op, foldEvents(events), T0 + 100);
  expect(result.queue).toEqual({ n: 1, medianMs: 10, p90Ms: 10 });
  expect(result.queued).toEqual({ n: 1, totalMs: 100, maxMs: 100 });
  expect(result.delivery.medianMs).toBe(40);
  expect(result.lead.medianMs).toBe(50);
  expect(result.deliveryReadyMs).toBe(10);
  expect(result.deliveredWork).toBe(1);
  expect(result.coverage.clockAnomalies).toBe(2);
});

test("relaunch ends occupancy but lifetime includes the interruption", () => {
  const op = makeOp([makeContact("a")]);
  const events = [launched(10), ev(10, "a", "socket-up", { generation: 1 }), ev(20, "a", "sample", { workers: 2 }), ev(30, "a", "reaped"), launched(50), ev(50, "a", "socket-up", { generation: 2 }), ev(60, "a", "socket-up", { generation: 2 }), ev(80, "a", "landed", { via: "merge" })];
  const result = evaluateOperation(op, foldEvents(events), T0 + 100);
  expect(result.attempts.relaunches).toBe(1);
  expect(result.delivery.medianMs).toBe(70);
  expect(result.connectivity.connectedContactMs).toBe(50);
  expect(result.connectivity.peak).toBe(1);
  expect(result.workers.nonclosedWorkerMs).toBe(20);
});

test("closed report clocks freeze all ages and malformed optional evaluations are rejected", () => {
  const op = makeOp([makeContact("a"), makeContact("b")]);
  const events = [ev(0, "a", "queued"), ev(0, "b", "queued"), launched(10), ev(20, "a", "phase", { from: null, to: "execute" }), ev(50, null, "closed", { outcome: "abandoned" })];
  const first = buildReport(op, events, new Date(T0 + 100));
  expect(buildReport(op, JSON.parse(JSON.stringify(events)), new Date(T0 + 1000)).evaluation).toEqual(first.evaluation);
  expect(first.evaluation!.queued.maxMs).toBe(50);
  expect(first.evaluation!.unfinished.maxMs).toBe(40);
  expect(parseEvaluation(first.evaluation)).toEqual(first.evaluation!);
  expect(parseEvaluation({ ...first.evaluation, asOf: NaN })).toBeNull();
  expect(parseEvaluation({ ...first.evaluation, usage: { ...first.evaluation!.usage, knownCostUsd: Infinity } })).toBeNull();
  expect(buildReport(op, [], new Date(T0)).evaluation).toBeUndefined();
  expect(parseEvaluation({ ...first.evaluation, attempts: {} })).toBeNull();
});

test("cumulative source snapshots deduplicate contacts and preserve observed usage after resets", () => {
  const op = makeOp([makeContact("a"), makeContact("b")]);
  const events = [launched(0), launched(0, "b"), ev(1, "a", "sample", { usage: { tokens: { input: 999, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 9 } }), ev(2, "a", "sample", { usageEvidence: usage(100) }), ev(3, "b", "sample", { usageEvidence: usage(120) }), ev(4, "a", "sample", { usageEvidence: usage(80) })];
  const result = evaluateOperation(op, foldEvents(events), T0 + 10);
  expect(result.usage.tokens!.input).toBe(120);
  expect(result.usage.knownCostUsd).toBe(1.2);
  expect(result.usage.basis).toBe("scoped");
  expect(result.coverage.counterResets).toBe(1);
  expect(result.usage.partial).toBe(true);
  expect(result.usage.costPerDelivered).toBeNull();
});
test("usage deltas attribute to the phase active at sample time and rebase on resets", () => {
  const op = makeOp([makeContact("a"), makeContact("b"), makeContact("c")]);
  const events = [
    launched(0), launched(0, "b"), launched(0, "c"),
    ev(10, "a", "phase", { from: null, to: "execute" }),
    ev(10, "b", "phase", { from: null, to: "execute" }),
    ev(10, "c", "phase", { from: null, to: "execute" }),
    ev(20, "a", "sample", { usageEvidence: usage(100) }),
    ev(20, "b", "sample", { usage: { tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 1 } }),
    ev(20, "c", "sample", { usage: { tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 1 } }),
    ev(30, "a", "phase", { from: "execute", to: "review" }),
    ev(30, "c", "phase", { from: "execute", to: "review" }),
    ev(40, "a", "sample", { usageEvidence: usage(300) }),
    ev(40, "b", "sample", { usage: { tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 2 } }),
    // Contact c emits the coordinator-session total AND scoped evidence in the same sample:
    // the evidence total is authoritative; the legacy field's delta must not double-count it.
    ev(40, "c", "sample", {
      usage: { tokens: { input: 80, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 2 },
      usageEvidence: usage(200),
    }),
    ev(50, "a", "sample", { usageEvidence: usage(120) }),
    ev(60, "a", "sample", { usageEvidence: usage(150) }),
    ev(60, "c", "sample", {
      usage: { tokens: { input: 130, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 4 },
      usageEvidence: usage(260),
    }),
  ];
  const result = evaluateOperation(op, foldEvents(events), T0 + 70);
  expect(result.usage.byPhase!.review.tokens).toBe(290);
  expect(result.usage.byPhase!.review.costUsd).toBeCloseTo(2.9, 10);
  expect(result.usage.byPhase!.execute.tokens).toBe(10);
  expect(result.usage.byPhase!.execute.costUsd).toBeCloseTo(1, 10);
});


test("run identity separates counters while latest findings do not become cumulative defects", () => {
  const op = makeOp([makeContact("a")]);
  const mission = (id: string) => ({ id, hold: "none", verify: null, complete: false });
  const events = [ev(0, "a", "sample", { mission: mission("one"), measurements: measurements({ recordedFailed: 3, latestActionable: 2 }) }), ev(1, "a", "sample", { mission: mission("one"), measurements: measurements({ recordedFailed: 3, latestActionable: 1 }) }), ev(2, "a", "sample", { mission: mission("two"), measurements: measurements({ recordedPassed: 1 }) })];
  const result = evaluateOperation(op, foldEvents(events), T0 + 10);
  expect(result.quality!.recordedFailed).toBe(3);
  expect(result.quality!.recordedPassed).toBe(1);
  expect(result.quality!.latestActionable).toBe(0);
  expect(result.fleet.workerAttempts).toBe(4);
});

test("explicit holds and final completion interval survive intervening repairs", () => {
  const op = makeOp([makeContact("a")]);
  const events = [launched(0), ev(10, "a", "sample", { mission: { id: "r", hold: "gate", verify: null, complete: false } }), ev(20, "a", "sample", { mission: { id: "r", hold: "none", verify: null, complete: false } }), ev(30, "a", "phase", { from: null, to: "complete" }), ev(40, "a", "phase", { from: "complete", to: "repair" }), ev(60, "a", "phase", { from: "repair", to: "complete" }), ev(70, "a", "landed", { via: "manual" })];
  const result = evaluateOperation(op, foldEvents(events), T0 + 100);
  expect(result.holdMs.gate).toBe(10);
  expect(result.deliveryReadyMs).toBe(10);
  expect(result.phaseMs.repair).toBe(20);
});

test("new evidence validates bounded sources and unknown counters rather than coercing zeros", () => {
  expect(parseMeasurements(measurements())).not.toBeNull();
  expect(parseMeasurements(measurements({ recordedFailed: -1 }))).toBeNull();
  expect(parseMeasurements(measurements({ recordedFailed: 1.5 }))).toBeNull();
  expect(parseUsageEvidence(usage(100))).not.toBeNull();
  expect(parseUsageEvidence({ ...usage(100), sources: [...usage(100).sources, ...usage(100).sources] })).toBeNull();
  expect(parseUsageEvidence({ ...usage(100), missing: Infinity })).toBeNull();
});

test("recommendations respect sample boundaries and carry evidence without causal claims", () => {
  const op = makeOp([makeContact("a")]);
  const base: Event[] = [launched(0), ev(1, "a", "sample", { mission: { id: "r", hold: "none", verify: null, complete: false }, measurements: measurements({ recordedFailed: 3, repeatedFailedRevision: 2 }) })];
  const four = [...base, ...Array.from({ length: 4 }, (_, i) => ev(10 + i, "a", "land-attempt", { outcome: i < 2 ? "conflict" : "clean" }))];
  let d = foldEvents(four), e = evaluateOperation(op, d, T0 + 100);
  expect(recommendEvaluation(e, evaluationEvidence(op, d, T0 + 100)).map(r => r.id)).toContain("repeat-verification");
  expect(recommendEvaluation(e, evaluationEvidence(op, d, T0 + 100)).map(r => r.id)).not.toContain("integration-conflicts");
  d = foldEvents([...four, ev(20, "a", "land-attempt", { outcome: "clean" })]); e = evaluateOperation(op, d, T0 + 100);
  const rule = recommendEvaluation(e, evaluationEvidence(op, d, T0 + 100)).find(r => r.id === "integration-conflicts")!;
  expect(rule.evidence.numerator).toBe(2); expect(rule.evidence.denominator).toBe(5);
  expect(rule.caveat).toContain("do not establish concurrency");
});

test("sample history strictly validates optional evidence and clears scoped groups on mission switches",()=>{
 const mission={id:"first",hold:"none" as const,verify:null,complete:false},m=measurements({latestActionable:2,recordedFailed:1}),u=usage(4);
 const first=validateEvent(ev(0,"a","sample",{mission,measurements:m,usageEvidence:u}));
 for(const fields of [{measurements:{...m,recordedFailed:-1}},{usageEvidence:{...u,sources:[...u.sources,...u.sources]}},{mission:{...mission,hold:"invalid"}}])
  expect(()=>validateEvent({...first,...fields})).toThrow();
 const empty=validateEvent(ev(1,"a","sample",{mission:{...mission,id:"second"},measurements:null,usageEvidence:null}));
 expect(empty).toMatchObject({measurements:null,usageEvidence:null});
 const folded=foldEvents([first,ev(10,"a","sample",{mission:{...mission,id:"second"}})]);
 expect(folded.contacts.a.lastSample?.measurements).toBeUndefined();
 expect(folded.contacts.a.lastSample?.usageEvidence).toBeUndefined();
 const result=evaluateOperation(makeOp([makeContact("a")]),folded,T0+20);
 expect(result.quality?.recordedFailed).toBe(1);
 expect(result.quality?.latestActionable).toBe(0);
});

test("recoverable scan backlog clears within a run but an unresolved previous run remains partial",()=>{
 const mission={id:"one",hold:"none" as const,verify:null,complete:false};
 const first=ev(1,"a","sample",{mission,usageEvidence:{...usage(4),missing:1,backlogBytes:100,partial:true}});
 const recovered=ev(2,"a","sample",{usageEvidence:usage(8)});
 const op=makeOp([makeContact("a")]);
 const healthy=evaluateOperation(op,foldEvents([launched(0),first,recovered]),T0+3);
 expect(healthy.usage.backlogBytes).toBe(0);expect(healthy.usage.missingSources).toBe(0);expect(healthy.usage.partial).toBe(false);
 const switched=ev(2,"a","sample",{mission:{...mission,id:"two"},usageEvidence:usage(8)});
 expect(evaluateOperation(op,foldEvents([launched(0),first,switched]),T0+3).usage.partial).toBe(true);
});
