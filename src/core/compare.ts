import type { MeasurementConfig } from "./types.ts";
import type { Distribution, Evaluation } from "./evaluation.ts";
import type { OperationReport } from "./report.ts";

/**
 * P4 offline comparisons. Pure: no file access, no clocks, no actions.
 * Inputs are operator-selected archived reports plus operator attestations;
 * outputs stay descriptive — never a winner, score, or causal claim.
 */

export interface Delta { n: number; median: number | null; medianPercent: number | null }
export interface GroupResult {
  trials: number; deliveredWork: number; incompleteTrials: number;
  external: { pass: number; fail: number; unassessed: number };
  delivery: Distribution; lead: Distribution;
  recordedFailed: number | null; acceptedRepairs: number | null; reviewFailures: number | null;
  knownCostUsd: number | null; costPerDelivered: number | null;
  partialUsageTrials: number; missingEvaluationTrials: number;
}
export interface ComparisonTrialResult {
  archive: string; group: "A" | "B"; pair: string;
  deliveredWork: number; unfinishedWork: number; deliveryMs: number | null;
  leadMs: number | null; knownCostUsd: number | null; costPerDelivered: number | null;
  partial: boolean; externalOutcome: "pass" | "fail" | "unassessed";
}
export interface ComparisonResult {
  v: 1; comparable: boolean; reasons: string[]; baseline: "A" | "B";
  variable: "maxWorkers"; pairs: number; groups: { A: GroupResult; B: GroupResult };
  differences: { deliveryMs: Delta; leadMs: Delta; costPerDeliveredUsd: Delta } | null;
  trials: ComparisonTrialResult[];
}

export interface ManifestTrial {
  archive: string; group: "A" | "B"; pair: string; repo: string; baseCommit: string;
  workload: string; acceptance: string; environment: string; externalOutcome: "pass" | "fail" | "unassessed";
}
export interface CompareManifest {
  v: 1; variable: "maxWorkers"; baseline: "A" | "B";
  groups: { A: number; B: number }; trials: ManifestTrial[];
}

const OUTCOMES = ["pass", "fail", "unassessed"] as const;
const ATTESTED = ["repo", "baseCommit", "workload", "acceptance", "environment"] as const;

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const short = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4000;
const limit = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 64;

export function parseManifest(value: unknown): CompareManifest {
  if (!record(value) || value.v !== 1) throw new Error("manifest must be an object with v 1");
  if (value.variable !== "maxWorkers") throw new Error("manifest variable must be \"maxWorkers\"; other variables need a separately reviewed protocol");
  if (value.baseline !== "A" && value.baseline !== "B") throw new Error("manifest baseline must be \"A\" or \"B\"");
  if (!record(value.groups) || !limit(value.groups.A) || !limit(value.groups.B) || Object.keys(value.groups).some(k => k !== "A" && k !== "B"))
    throw new Error("manifest groups must be exactly {A: 1..64, B: 1..64}");
  if (!Array.isArray(value.trials) || value.trials.length === 0 || value.trials.length > 100)
    throw new Error("manifest trials must be a non-empty array of at most 100 entries");
  const archives = new Set<string>(), slots = new Set<string>();
  const trials: ManifestTrial[] = value.trials.map((raw, i) => {
    if (!record(raw)) throw new Error(`manifest trial ${i + 1} must be an object`);
    const t = raw as Record<string, unknown>;
    if (t.group !== "A" && t.group !== "B") throw new Error(`manifest trial ${i + 1} group must be "A" or "B"`);
    for (const k of ["archive", "pair", ...ATTESTED]) if (!short(t[k])) throw new Error(`manifest trial ${i + 1} ${k} must be a non-empty string`);
    if (!OUTCOMES.includes(t.externalOutcome as (typeof OUTCOMES)[number])) throw new Error(`manifest trial ${i + 1} externalOutcome must be pass, fail or unassessed`);
    const archive = t.archive as string, slot = `${t.group}:${t.pair}`;
    if (archives.has(archive)) throw new Error(`manifest repeats archive "${archive}"`);
    if (slots.has(slot)) throw new Error(`manifest repeats pair "${t.pair}" group ${t.group}`);
    archives.add(archive); slots.add(slot);
    return t as unknown as ManifestTrial;
  });
  return { v: 1, variable: "maxWorkers", baseline: value.baseline, groups: { A: value.groups.A, B: value.groups.B }, trials };
}

interface TrialFacts {
  archive: string; group: "A" | "B"; pair: string; externalOutcome: ManifestTrial["externalOutcome"];
  trial: ManifestTrial; report: OperationReport; evaluation: Evaluation | null;
  deliveredWork: number; unfinishedWork: number; deliveryMs: number | null; leadMs: number | null;
  knownCostUsd: number | null; costPerDelivered: number | null; usagePartial: boolean; costClean: boolean;
}

const work = (kind: string) => kind === "implement" || kind === "audit";

function facts(trial: ManifestTrial, report: OperationReport): TrialFacts {
  const e = report.evaluation ?? null;
  const workContacts = report.contacts.filter(c => work(c.kind));
  const deliveredWork = e?.deliveredWork ?? workContacts.filter(c => c.final === "landed").length;
  const unfinishedWork = workContacts.filter(c => c.final === "aborted").length;
  const u = e?.usage;
  const costClean = u?.basis === "scoped" && u.missingSources === 0 && u.unsupportedWorkers === 0
    && u.malformedLines === 0 && u.resets === 0 && u.backlogBytes === 0 && u.partial === false;
  return {
    archive: trial.archive, group: trial.group, pair: trial.pair, externalOutcome: trial.externalOutcome,
    trial, report, evaluation: e, deliveredWork, unfinishedWork,
    deliveryMs: e?.delivery.medianMs ?? null, leadMs: e?.lead.medianMs ?? null,
    knownCostUsd: u?.knownCostUsd ?? null, costPerDelivered: u?.costPerDelivered ?? null,
    usagePartial: u === undefined || u.basis !== "scoped" || u.partial, costClean,
  };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const distributionOf = (xs: number[]): Distribution => ({ n: xs.length, medianMs: median(xs), p90Ms: xs.length ? [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.9) - 1] : null });

const deltaOf = (deltas: number[], pcts: number[]): Delta => ({ n: deltas.length, median: median(deltas), medianPercent: median(pcts) });

function groupResult(trials: TrialFacts[]): GroupResult {
  const quality = (k: "recordedFailed" | "acceptedRepairs" | "reviewFailures") =>
    trials.every(t => t.evaluation?.quality) ? trials.reduce((n, t) => n + t.evaluation!.quality![k], 0) : null;
  const external = { pass: 0, fail: 0, unassessed: 0 };
  for (const t of trials) external[t.externalOutcome] += 1;
  const costs = trials.map(t => t.knownCostUsd).filter((v): v is number => v !== null);
  const knownCostUsd = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  const deliveredWork = trials.reduce((n, t) => n + t.deliveredWork, 0);
  return {
    trials: trials.length, deliveredWork,
    incompleteTrials: trials.filter(t => t.unfinishedWork > 0).length,
    external,
    delivery: distributionOf(trials.map(t => t.deliveryMs).filter((v): v is number => v !== null)),
    lead: distributionOf(trials.map(t => t.leadMs).filter((v): v is number => v !== null)),
    recordedFailed: quality("recordedFailed"), acceptedRepairs: quality("acceptedRepairs"), reviewFailures: quality("reviewFailures"),
    knownCostUsd,
    costPerDelivered: deliveredWork > 0 && knownCostUsd !== null ? knownCostUsd / deliveredWork : null,
    partialUsageTrials: trials.filter(t => t.usagePartial).length,
    missingEvaluationTrials: trials.filter(t => t.evaluation === null).length,
  };
}

const CONFIG_FIELDS: (keyof MeasurementConfig)[] = ["graph", "frontend", "reviewConcurrency", "mode"];

/** One arm of a pair; null when the archive produced no report for the trial. */
export interface LoadedTrial { trial: ManifestTrial; report: OperationReport | null }

export function compareManifest(manifest: CompareManifest, loaded: LoadedTrial[]): ComparisonResult {
  if (loaded.length !== manifest.trials.length) throw new Error(`manifest expects ${manifest.trials.length} trials, got ${loaded.length}`);
  const factsList: (TrialFacts | null)[] = loaded.map(({ trial, report }) => {
    if (report === null) return null;
    if (report.repo !== trial.repo)
      throw new Error(`archive "${trial.archive}" is for repo "${report.repo}", not manifest repo "${trial.repo}"`);
    return facts(trial, report);
  });

  const reasons: string[] = [];
  const byPair = new Map<string, Partial<Record<"A" | "B", TrialFacts | null>>>();
  for (const [i, f] of factsList.entries()) {
    const t = manifest.trials[i];
    (byPair.get(t.pair) ?? byPair.set(t.pair, {}).get(t.pair)!)[t.group] = f;
  }

  interface Pair { pair: string; base: TrialFacts; cand: TrialFacts; comparable: boolean; reason: string | null }
  const pairs: Pair[] = [];
  const other = manifest.baseline === "A" ? "B" : "A";
  for (const [pair, arms] of [...byPair.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const a = arms[manifest.baseline], b = arms[other];
    if (a === undefined || b === undefined) { reasons.push(`pair ${pair}: missing group ${a === undefined ? manifest.baseline : other} arm`); continue; }
    if (a === null || b === null) { reasons.push(`pair ${pair}: ${a === null ? manifest.baseline : other} archive has no report; no evaluation exists to compare`); continue; }
    const p: Pair = { pair, base: a, cand: b, comparable: true, reason: null };
    const diffs = ATTESTED.filter(k => a.trial[k] !== b.trial[k]);
    if (diffs.length) p.reason = `pair ${pair}: attested ${diffs.join(", ")} differ (${diffs.map(k => `${JSON.stringify(a.trial[k])} vs ${JSON.stringify(b.trial[k])}`).join("; ")}); operator attestations are unverified but must match`;
    else {
      for (const [arm, f] of [[manifest.baseline, a], [other, b]] as const) {
        const e = f.evaluation;
        if (!e) p.reason = `pair ${pair}: group ${arm} archive has no v1 evaluation`;
        else if (e.config.value === null) p.reason = `pair ${pair}: group ${arm} has no producer config evidence`;
        else if (e.config.mixed) p.reason = `pair ${pair}: group ${arm} observed mixed configs; the arm is not one experiment`;
        else {
          const c = e.config.value;
          if (c.maxWorkers !== manifest.groups[arm]) p.reason = `pair ${pair}: group ${arm} observed maxWorkers ${c.maxWorkers}, manifest declares ${manifest.groups[arm]}`;
          else if (manifest.variable === "maxWorkers" && c.graph !== "beads") p.reason = `pair ${pair}: group ${arm} ran graph "${c.graph}"; worker-parallelism comparison needs beads`;
          else if (manifest.variable === "maxWorkers" && (e.fleet.workerAttempts === null || e.fleet.workerAttempts < 2)) p.reason = `pair ${pair}: group ${arm} recorded ${e.fleet.workerAttempts ?? "no"} worker dispatch reservations; a coordinator-only task cannot evaluate worker parallelism`;
        }
        if (p.reason) break;
      }
      if (!p.reason) {
        const ca = a.evaluation!.config.value!, cb = b.evaluation!.config.value!;
        const field = CONFIG_FIELDS.find(k => ca[k] !== cb[k]);
        if (field) p.reason = `pair ${pair}: observed config ${field} differs (${JSON.stringify(ca[field])} vs ${JSON.stringify(cb[field])})`;
      }
    }
    p.comparable = p.reason === null;
    if (p.reason) reasons.push(p.reason);
    pairs.push(p);
  }
  if (pairs.length < 5) reasons.push(`only ${pairs.length} complete pairs; controlled comparison needs at least 5 paired trial identities`);

  const comparable = reasons.length === 0;
  let differences: ComparisonResult["differences"] = null;
  if (comparable) {
    const collect = (metric: (t: TrialFacts) => number | null) => {
      const deltas: number[] = [], pcts: number[] = [];
      for (const p of pairs) {
        const b = metric(p.base), c = metric(p.cand);
        if (b === null || c === null) continue;
        deltas.push(c - b);
        if (b !== 0) pcts.push((c - b) / b * 100);
      }
      return deltaOf(deltas, pcts);
    };
    const costPairs = pairs.filter(p => p.base.costClean && p.cand.costClean);
    const rejected = pairs.length - costPairs.length;
    if (rejected) reasons.push(`cost deltas use ${costPairs.length} pairs with clean scoped coverage; ${rejected} pair${rejected === 1 ? "" : "s"} had missing, legacy, reset or partial usage evidence — figures remain known associated estimates, not mission-exclusive billing`);
    differences = { deliveryMs: collect(t => t.deliveryMs), leadMs: collect(t => t.leadMs), costPerDeliveredUsd: collect(t => (t.costClean ? t.costPerDelivered : null)) };
  }

  return {
    v: 1, comparable, reasons, baseline: manifest.baseline, variable: manifest.variable,
    pairs: pairs.length,
    groups: {
      A: groupResult(factsList.filter((f): f is TrialFacts => f !== null && f.group === "A")),
      B: groupResult(factsList.filter((f): f is TrialFacts => f !== null && f.group === "B")),
    },
    differences,
    trials: loaded.map(({ trial }, i) => {
      const f = factsList[i];
      return {
        archive: trial.archive, group: trial.group, pair: trial.pair,
        deliveredWork: f?.deliveredWork ?? 0, unfinishedWork: f?.unfinishedWork ?? 0,
        deliveryMs: f?.deliveryMs ?? null, leadMs: f?.leadMs ?? null,
        knownCostUsd: f?.knownCostUsd ?? null, costPerDelivered: f?.costPerDelivered ?? null,
        partial: f === null || f.evaluation === null || f.usagePartial,
        externalOutcome: trial.externalOutcome,
      };
    }),
  };
}
