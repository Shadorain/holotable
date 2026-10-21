import { describe, expect, test } from "bun:test";
import { computeRollup, type RollupEntry } from "../../src/core/rollup.ts";
import { evaluateOperation } from "../../src/core/evaluation.ts";
import { foldEvents } from "../../src/core/fold.ts";
import type { Event } from "../../src/core/types.ts";
import { ev, iso, makeContact, makeMeasurements, makeOp, makeUsageEvidence, T0 } from "./fixtures.ts";

const NOW = T0 + 10_000_000;

function evalOf(events: Event[], contacts = [makeContact("a")]): RollupEntry {
  const op = makeOp(contacts);
  return { name: op.name, closedAt: null, source: "open", evaluation: evaluateOperation(op, foldEvents(events), NOW) };
}

describe("computeRollup", () => {
  test("empty input yields empty rankings without caveats beyond the no-data note", () => {
    const r = computeRollup([], NOW);
    expect(r.sources.evaluated).toBe(0);
    expect(r.failures).toEqual([]);
    expect(r.waits).toEqual([]);
    expect(r.phases).toEqual([]);
    expect(r.cohorts).toEqual([]);
    expect(r.totals.delivered).toBe(0);
    expect(r.totals.knownCostUsd).toBeNull();
    expect(r.caveats.some(c => c.includes("No timed contacts"))).toBe(true);
  });

  test("sources missing evaluation count separately and never appear in rankings", () => {
    const r = computeRollup([{ name: "old", closedAt: iso(5_000_000), source: "archive", evaluation: null }], NOW);
    expect(r.sources.archived).toBe(1);
    expect(r.sources.missingEvaluation).toBe(1);
    expect(r.caveats.some(c => c.includes("no evaluation"))).toBe(true);
    expect(r.failures).toEqual([]);
  });

  test("failure classes rank by magnitude with denominator-aware rates", () => {
    const events = [
      ev(0, "a", "queued"),
      ev(1, "a", "launched"),
      ev(2, "a", "launched"),
      ev(3, "a", "launched"),
      ev(4, "a", "land-attempt", { outcome: "conflict" }),
      ev(5, "a", "land-attempt", { outcome: "landed" }),
      ev(6, "a", "landed"),
      ev(7, "a", "sample", { mission: { id: "m1", hold: null, complete: true }, measurements: makeMeasurements({ reviewFailures: 5, completedRounds: 10, acceptedRepairs: 2 }) }),
      ev(8, "a", "sample", { usageEvidence: makeUsageEvidence(4000, 12.5) }),
      ev(9, null, "closed", { outcome: "landed" }),
    ];
    const r = computeRollup([evalOf(events)], NOW);
    const launches = r.failures.find(f => f.id === "launches")!;
    expect(launches.value).toBe(2); // relaunches = launches - 1 per contact
    expect(launches.rate).toBeCloseTo(2 / 3);
    expect(launches.operations).toBe(1);
    const conflicts = r.failures.find(f => f.id === "conflicts")!;
    expect(conflicts.value).toBe(1);
    expect(conflicts.rate).toBeCloseTo(0.5);
    const review = r.failures.find(f => f.id === "review-failures")!;
    expect(review.value).toBe(5);
    expect(review.denominator).toBe(15); // completed + failed rounds
    const order = r.failures.map(f => f.id);
    expect(order.indexOf("review-failures")).toBeLessThan(order.indexOf("repairs"));
  });

  test("waits and phases rank milliseconds and share of their totals", () => {
    const events = [
      ev(0, "a", "queued"),
      ev(1, "a", "blocked"),
      ev(1001, "a", "unblocked"),
      ev(1002, "a", "launched"),
      ev(1003, "a", "phase", { to: "plan" }),
      ev(2003, "a", "phase", { to: "verify" }),
      ev(3003, "a", "phase", { to: "review" }),
      ev(9003, "a", "landed"),
    ];
    const r = computeRollup([evalOf(events)], NOW);
    const dependency = r.waits.find(w => w.id === "dependency")!;
    expect(dependency.value).toBe(1000);
    expect(r.waits[0]!.id).toBe("dependency");
    const review = r.phases.find(p => p.id === "review")!;
    const verify = r.phases.find(p => p.id === "verify")!;
    expect(review.value).toBe(6000);
    expect(verify.value).toBe(1000);
    expect(review.rate!).toBeGreaterThan(verify.rate!);
  });

  test("cohorts group by measurement config; uninstrumented sources separate", () => {
    const instrumented = [
      ev(0, "a", "queued"), ev(1, "a", "launched"),
      ev(2, "a", "sample", { mission: { id: "m", hold: null, complete: false }, measurements: makeMeasurements() }),
      ev(3, "a", "sample", { usageEvidence: makeUsageEvidence(2000, 8) }),
      ev(4, "a", "landed"),
    ];
    const uninstrumented = [
      ev(0, "a", "queued"), ev(1, "a", "launched"), ev(2, "a", "landed"),
    ];
    const r = computeRollup([evalOf(instrumented), evalOf(uninstrumented)], NOW);
    expect(r.cohorts.length).toBe(2);
    const known = r.cohorts.find(c => c.key.includes("beads"))!;
    expect(known.delivered).toBe(1);
    expect(known.knownCostUsd).toBeCloseTo(8);
    const legacy = r.cohorts.find(c => c.key === "uninstrumented")!;
    expect(legacy.knownCostUsd).toBeNull();
  });

  test("usage totals sum and cost per delivered divides fleet-wide", () => {
    const mk = (cost: number) => evalOf([
      ev(0, "a", "queued"), ev(1, "a", "launched"),
      ev(2, "a", "sample", { usageEvidence: makeUsageEvidence(1000, cost) }),
      ev(3, "a", "landed"),
    ]);
    const r = computeRollup([mk(10), mk(20)], NOW);
    expect(r.totals.knownCostUsd).toBeCloseTo(30);
    expect(r.totals.delivered).toBe(2);
    expect(r.totals.costPerDelivered).toBeCloseTo(15);
    expect(r.totals.tokens!.input).toBe(2000);
  });
  test("phase costs rank attributed usage deltas and stay empty without them", () => {
    const events = [
      ev(0, "a", "queued"), ev(1, "a", "launched"),
      ev(2, "a", "phase", { to: "execute" }),
      ev(3, "a", "sample", { usageEvidence: makeUsageEvidence(1000, 5) }),
      ev(4, "a", "phase", { to: "review" }),
      ev(5, "a", "sample", { usageEvidence: makeUsageEvidence(3000, 9) }),
      ev(6, "a", "landed"),
    ];
    const r = computeRollup([evalOf(events)], NOW);
    const review = r.costs.find(c => c.id === "review")!;
    expect(review.value).toBeCloseTo(4);
    expect(review.unit).toBe("usd");
    expect(review.rate!).toBeCloseTo(1);
    expect(r.costs.find(c => c.id === "execute")).toBeUndefined();
    const plain = computeRollup([evalOf([ev(0, "a", "queued"), ev(1, "a", "launched"), ev(2, "a", "landed")])], NOW);
    expect(plain.costs).toEqual([]);
  });
  test("zero-failure operations contribute denominators and disjoint phases share fleet totals", () => {
    const failed = evalOf([
      ev(0, "a", "launched"), ev(1, "a", "land-attempt", { outcome: "conflict" }),
      ev(2, "a", "phase", { to: "review" }), ev(102, "a", "landed"),
    ]);
    const clean = evalOf([
      ev(0, "a", "launched"), ev(1, "a", "land-attempt", { outcome: "clean" }),
      ev(2, "a", "phase", { to: "execute" }), ev(302, "a", "landed"),
    ]);
    const r = computeRollup([failed, clean], NOW);
    expect(r.failures.find(m => m.id === "conflicts")).toMatchObject({ value: 1, denominator: 2, rate: 0.5, operations: 1 });
    expect(r.phases.find(m => m.id === "review")).toMatchObject({ value: 100, denominator: 400, rate: 0.25 });
    expect(r.phases.find(m => m.id === "execute")).toMatchObject({ value: 300, denominator: 400, rate: 0.75 });
  });

  test("draft-only spend remains visible without a fictitious delivered-operation cost", () => {
    const r = computeRollup([], NOW, { tokens: 100, costUsd: 2, sessions: 1, partial: true });
    expect(r.totals.panes).toMatchObject({ tokens: 100, costUsd: 2, sessions: 1, partial: true });
    expect(r.totals.drafts).toMatchObject({ costUsd: 2, partial: true });
    expect(r.totals.knownCostUsd).toBeNull();
    expect(r.totals.costPerDelivered).toBeNull();
    expect(r.totals.reviews).toBeNull();
    expect(r.totals.repairRounds).toBeNull();
  });

  test("missing review instrumentation is unknown while recorded zero rounds remain zero", () => {
    const missing = evalOf([ev(0, "a", "launched")]);
    expect(computeRollup([missing], NOW).totals.reviews).toBeNull();
    const observed = evalOf([ev(0, "a", "sample", { mission: { id: "instrumented", hold: null, complete: false }, measurements: makeMeasurements() })]);
    expect(computeRollup([missing, observed], NOW).totals.reviews).toBe(0);
  });

  test("activity, operator wait and spend sum over the sources that report them", () => {
    const mk = (cost: number) => evalOf([
      ev(0, "a", "queued"), ev(1000, "a", "launched"),
      ev(2000, "a", "sample", { usageEvidence: makeUsageEvidence(1000, cost) }),
      ev(3_601_000, "a", "landed"),
    ]);
    const a = mk(4), b = mk(6);
    const archived = mk(100);
    const old = archived.evaluation!;
    delete old.activity;
    delete old.operatorWait;
    delete old.usage.spend;
    const r = computeRollup([a, b, archived], NOW);
    const ea = a.evaluation!, eb = b.evaluation!;
    expect(r.totals.activity).toMatchObject({ operations: 2, activeMs: ea.activity!.activeMs + eb.activity!.activeMs, delivered: 2 });
    expect(r.totals.activity!.deliveriesPerActiveHour).toBeCloseTo(2 * 3_600_000 / (ea.activity!.activeMs + eb.activity!.activeMs));
    expect(r.totals.operatorWait).toMatchObject({
      operations: 2,
      operatorMs: ea.operatorWait!.operatorMs + eb.operatorWait!.operatorMs,
      missionMs: ea.operatorWait!.missionMs + eb.operatorWait!.missionMs,
    });
    expect(r.totals.operatorWait!.byKind.launch!.waits).toBe(ea.operatorWait!.byKind.launch!.waits + eb.operatorWait!.byKind.launch!.waits);
    expect(r.totals.spend).toMatchObject({ operations: 2, landedPriced: 2 });
    expect(r.totals.spend!.landedUsd).toBeCloseTo(10); // the archive without a spend split adds nothing
    expect(r.totals.spend!.perLandedUsd).toBeCloseTo(5);
    expect(r.totals.knownCostUsd).toBeCloseTo(110);

    const legacy = computeRollup([archived], NOW).totals;
    expect(legacy.activity).toBeNull();
    expect(legacy.operatorWait).toBeNull();
    expect(legacy.spend).toBeNull();
  });

  test("rollups are deterministic for identical inputs", () => {
    const entries = [evalOf([ev(0, "a", "queued"), ev(1, "a", "launched"), ev(2, "a", "landed")])];
    expect(computeRollup(entries, NOW)).toEqual(computeRollup(entries, NOW));
  });
});
