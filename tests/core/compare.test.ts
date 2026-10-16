import { describe, expect, test } from "bun:test";
import { compareManifest, parseManifest, type CompareManifest, type LoadedTrial, type ManifestTrial } from "../../src/core/compare.ts";
import type { Evaluation } from "../../src/core/evaluation.ts";
import type { OperationReport } from "../../src/core/report.ts";
import { evaluation, reportContact, reportFixture } from "../helpers.ts";

const REPO = "/repo";
const trial = (group: "A" | "B", pair: string, over: Partial<ManifestTrial> = {}): ManifestTrial => ({
  archive: `arc-${pair}-${group}`, group, pair, repo: REPO, baseCommit: "c".repeat(40),
  workload: "fixture-v1", acceptance: "smoke-v1", environment: "host-v1", externalOutcome: "unassessed", ...over,
});

const manifest = (trials: ManifestTrial[], over: Partial<CompareManifest> = {}): CompareManifest => ({
  v: 1, variable: "maxWorkers", baseline: "A", groups: { A: 1, B: 2 }, trials, ...over,
});

const report = (e: Evaluation | null, over: Partial<OperationReport> = {}): OperationReport =>
  reportFixture(e === null ? { evaluation: undefined, ...over } : { evaluation: e, ...over });

const arm = (group: "A" | "B", e: Evaluation | null) => {
  const mw = group === "A" ? 1 : 2;
  return e === null ? null : {
    ...e,
    config: { value: e.config.value === null ? null : { ...e.config.value, maxWorkers: mw }, mixed: e.config.mixed },
  };
};

const load = (trials: ManifestTrial[], arms: Record<string, OperationReport | null>): LoadedTrial[] =>
  trials.map((t) => {
    const rep = arms[`${t.pair}:${t.group}`];
    if (rep === undefined) throw new Error(`fixture missing ${t.pair}:${t.group}`);
    return rep === null ? { trial: t, report: null } : { trial: t, report: rep };
  });

const pairReports = (n: number, each: (group: "A" | "B", i: number) => Evaluation | null) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`w${i + 1}`, each] as const)
      .flatMap(([pair, fn]) => (["A", "B"] as const).map((g) => [`${pair}:${g}`, report(arm(g, fn(g, Number(pair.slice(1)) - 1)))])),
  );
const mutatedReports = (n: number, mutate: (e: Evaluation, g: "A" | "B") => Evaluation) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => `w${i + 1}`)
      .flatMap((pair) => (["A", "B"] as const).map((g) => [`${pair}:${g}`, report(mutate(arm(g, ev({}))!, g))])),
  );

const fivePairs = Array.from({ length: 5 }, (_, i) => [trial("A", `w${i + 1}`), trial("B", `w${i + 1}`)]).flat();
const ev = (over: Partial<Evaluation>): Evaluation => evaluation({ fleet: { workerAttempts: 3, workerBeads: 3, redispatches: 0, repairRound: 1, repairLinks: 0, boardResendRequests: 0 }, ...over });

describe("parseManifest", () => {
  test("rejects malformed input with specific errors", () => {
    expect(() => parseManifest(null)).toThrow("v 1");
    expect(() => parseManifest({ v: 1, variable: "model", baseline: "A", groups: { A: 1, B: 2 }, trials: [trial("A", "w")] }))
      .toThrow("maxWorkers");
    expect(() => parseManifest(manifest(fivePairs, { baseline: "C" as "A" }))).toThrow('baseline must be "A" or "B"');
    expect(() => parseManifest(manifest(fivePairs, { groups: { A: 0, B: 2 } }))).toThrow("1..64");
    expect(() => parseManifest(manifest([...fivePairs, { ...trial("A", "wx"), archive: fivePairs[0].archive }]))).toThrow("repeats archive");
    expect(() => parseManifest(manifest([...fivePairs, trial("A", "w1", { archive: "other" })]))).toThrow('repeats pair "w1" group A');
    expect(() => parseManifest(manifest(fivePairs.map((t, i) => (i === 0 ? { ...t, externalOutcome: "great" as "pass" } : t))))).toThrow("externalOutcome");
    expect(() => parseManifest({ v: 1, variable: "maxWorkers", baseline: "A", groups: { A: 1, B: 2 }, trials: [] })).toThrow("non-empty");
    expect(() => parseManifest(manifest(Array.from({ length: 101 }, (_, i) => trial("A", `x${i}`))))).toThrow("100");
  });
});

describe("compareManifest", () => {
  test("five matched pairs produce baseline-relative descriptive deltas", () => {
    const arms = pairReports(5, (g, i) =>
      ev({
        deliveredWork: 2,
        delivery: { n: 2, medianMs: g === "A" ? 100 + i : 80 + i, p90Ms: null },
        lead: { n: 2, medianMs: g === "A" ? 200 + i : 160 + i, p90Ms: null },
        usage: { ...evaluation().usage, knownCostUsd: 4, costPerDelivered: 2 },
      }));
    const r = compareManifest(manifest(fivePairs), load(fivePairs, arms));
    expect(r.comparable).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.pairs).toBe(5);
    // A median deltas −20ms per pair; B is baseline candidate −20 vs A? baseline A: B−A = −20ms/−20%.
    expect(r.differences?.deliveryMs).toEqual({ n: 5, median: -20, medianPercent: expect.closeTo(-19.5, 0.5) });
    expect(r.differences?.leadMs.median).toBe(-40);
    expect(r.differences?.costPerDeliveredUsd.median).toBe(0);
    expect(r.groups.A.trials).toBe(5);
    expect(r.groups.B.knownCostUsd).toBe(20);
    expect(r.groups.B.costPerDelivered).toBe(2);
  });

  test("baseline B flips delta sign", () => {
    const arms = pairReports(5, (g) => ev({ delivery: { n: 1, medianMs: g === "A" ? 100 : 80, p90Ms: null } }));
    const r = compareManifest(manifest(fivePairs, { baseline: "B" }), load(fivePairs, arms));
    expect(r.comparable).toBe(true);
    // candidate A minus baseline B: +20/+25%.
    expect(r.differences?.deliveryMs).toEqual({ n: 5, median: 20, medianPercent: 25 });
  });

  test("mismatched attested fields make the pair incomparable", () => {
    const trials = fivePairs.map((t) => (t.pair === "w3" && t.group === "B" ? { ...t, workload: "fixture-v2" } : t));
    const r = compareManifest(manifest(trials), load(trials, pairReports(5, (g) => ev({}))));
    expect(r.comparable).toBe(false);
    expect(r.differences).toBeNull();
    expect(r.reasons.join("\n")).toContain("pair w3: attested workload differ");
    expect(r.reasons.join("\n")).toContain("attestations are unverified");
  });

  test("repo mismatch between report and manifest is an error, not a reason", () => {
    const arms = pairReports(5, (g) => ev({}));
    arms["w2:A"] = report(ev({}), { repo: "/other" });
    expect(() => compareManifest(manifest(fivePairs), load(fivePairs, arms))).toThrow('archive "arc-w2-A" is for repo "/other"');
  });

  test.each([
    ["mixed observed config", (e: Evaluation) => ({ ...e, config: { value: e.config.value, mixed: true } }), "mixed configs"],
    ["missing config evidence", (e: Evaluation) => ({ ...e, config: { value: null, mixed: false } }), "no producer config evidence"],
    ["wrong observed maxWorkers", (e: Evaluation, g: "A" | "B") => ({ ...e, config: { value: { ...e.config.value!, maxWorkers: g === "A" ? 4 : 2 }, mixed: false } }), "observed maxWorkers 4"],
    ["local graph cannot show worker parallelism", (e: Evaluation) => ({ ...e, config: { value: { ...e.config.value!, graph: "local" as const }, mixed: false } }), 'ran graph "local"'],
    ["coordinator-only task has no dispatch evidence", (e: Evaluation) => ({ ...e, fleet: { ...e.fleet, workerAttempts: 0 } }), "worker dispatch reservations"],
    ["different config fields across arms", (e: Evaluation, g: "A" | "B") => ({ ...e, config: { value: { ...e.config.value!, reviewConcurrency: g === "A" ? 1 : 2 }, mixed: false } }), "config reviewConcurrency differs"],
  ])("incomparable: %s", (_label, mutate, fragment) => {
    const r = compareManifest(manifest(fivePairs), load(fivePairs, mutatedReports(5, mutate)));
    expect(r.comparable).toBe(false);
    expect(r.differences).toBeNull();
    expect(r.reasons.join("\n")).toContain(fragment);
  });

  test("missing pair arm and fewer than five pairs are reported without fabricating deltas", () => {
    const trials = fivePairs.filter((t) => t.pair !== "w5" || t.group !== "B");
    const arms = pairReports(5, (g) => ev({}));
    const r = compareManifest(manifest(trials), load(trials, Object.fromEntries(Object.entries(arms).filter(([k]) => k !== "w5:B"))));
    expect(r.comparable).toBe(false);
    expect(r.reasons.join("\n")).toContain("pair w5: missing group B arm");
    expect(r.reasons.join("\n")).toContain("only 4 complete pairs; controlled comparison needs at least 5");
    expect(r.differences).toBeNull();
    expect(r.groups.B.trials).toBe(4);
  });

  test("an arm with no report keeps raw facts and blocks comparison", () => {
    const arms = pairReports(5, (g) => ev({}));
    const trials = fivePairs;
    const loaded = load(trials, arms).map((l) => (l.trial.pair === "w4" && l.trial.group === "A" ? { ...l, report: null } : l));
    const r = compareManifest(manifest(trials), loaded);
    expect(r.comparable).toBe(false);
    expect(r.reasons.join("\n")).toContain("pair w4: A archive has no report");
    const t = r.trials.find((x) => x.pair === "w4" && x.group === "A")!;
    expect(t.deliveredWork).toBe(0);
    expect(t.partial).toBe(true);
  });

  test("incomplete arms stay counted; missing timing reduces only that delta's n", () => {
    const arms = pairReports(5, (g, i) =>
      ev({
        deliveredWork: g === "A" && i === 0 ? 0 : 2,
        delivery: i === 0 ? { n: 0, medianMs: null, p90Ms: null } : { n: 1, medianMs: g === "A" ? 100 : 80, p90Ms: null },
      }));
    arms["w1:A"] = report(arm("A", ev({ deliveredWork: 0, delivery: { n: 0, medianMs: null, p90Ms: null } }))!, {
      contacts: [reportContact("a1", "landed"), reportContact("a2", "aborted")],
    });
    const r = compareManifest(manifest(fivePairs), load(fivePairs, arms));
    expect(r.comparable).toBe(true);
    expect(r.groups.A.incompleteTrials).toBe(1);
    expect(r.differences?.deliveryMs.n).toBe(4);
    expect(r.trials.find((t) => t.pair === "w1" && t.group === "A")!.unfinishedWork).toBe(1);
  });

  test("zero baseline omits that pair's percent, not its delta", () => {
    const arms = pairReports(5, (g, i) => ev({ delivery: { n: 1, medianMs: g === "A" ? (i === 0 ? 0 : 100) : 80, p90Ms: null } }));
    const r = compareManifest(manifest(fivePairs), load(fivePairs, arms));
    expect(r.differences?.deliveryMs.median).toBe(-20); // w1 delta 80−0, others −20 → median −20
    expect(r.differences?.deliveryMs.medianPercent).toBe(-20); // w1's percent is omitted: 0 baseline
  });

  test("partial or legacy usage excludes cost deltas but keeps timing", () => {
    const arms = pairReports(5, (g, i) =>
      ev({
        delivery: { n: 1, medianMs: g === "A" ? 100 : 80, p90Ms: null },
        usage: { ...evaluation().usage, basis: i === 2 ? "legacy" : "scoped", partial: i === 2, missingSources: i === 2 ? 1 : 0, costPerDelivered: 2 },
      }));
    const r = compareManifest(manifest(fivePairs), load(fivePairs, arms));
    expect(r.comparable).toBe(true);
    expect(r.differences?.deliveryMs.n).toBe(5);
    expect(r.differences?.costPerDeliveredUsd.n).toBe(4);
    expect(r.reasons.join("\n")).toContain("cost deltas use 4 pairs");
    expect(r.groups.A.partialUsageTrials).toBe(1);
  });

  test("missing evaluation blocks that pair and flags trial coverage", () => {
    const arms = pairReports(5, (g) => ev({}));
    arms["w2:B"] = report(null, { contacts: [reportContact("b1", "landed")] });
    const r = compareManifest(manifest(fivePairs), load(fivePairs, arms));
    expect(r.comparable).toBe(false);
    expect(r.reasons.join("\n")).toContain("pair w2: group B archive has no v1 evaluation");
    const t = r.trials.find((x) => x.pair === "w2" && x.group === "B")!;
    expect(t.deliveredWork).toBe(1); // conservative report count
    expect(t.partial).toBe(true);
    expect(r.groups.B.missingEvaluationTrials).toBe(1);
  });

  test("external outcomes are tallied as attestations, never synthesized", () => {
    const trials = fivePairs.map((t) => (t.group === "A" ? { ...t, externalOutcome: "pass" as const } : { ...t, externalOutcome: "fail" as const }));
    const r = compareManifest(manifest(trials), load(trials, pairReports(5, (g) => ev({ deliveredWork: g === "A" ? 2 : 0 }))));
    expect(r.groups.A.external).toEqual({ pass: 5, fail: 0, unassessed: 0 });
    expect(r.groups.B.external).toEqual({ pass: 0, fail: 5, unassessed: 0 });
    expect(r.groups.B.deliveredWork).toBe(0);
    // No "B failed therefore worse" claim: outcome stays raw.
    expect(r.comparable).toBe(true);
  });
});
