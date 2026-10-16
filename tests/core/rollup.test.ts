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


  test("rollups are deterministic for identical inputs", () => {
    const entries = [evalOf([ev(0, "a", "queued"), ev(1, "a", "launched"), ev(2, "a", "landed")])];
    expect(computeRollup(entries, NOW)).toEqual(computeRollup(entries, NOW));
  });
});
