import { RECOVERY_DEFERRALS } from "../types.ts";
import { distribution, isWork, MS_PER_HOUR } from "./shared.ts";
import type { ContactReport, Evaluation, FoldEvaluation, LaunchCohort, SeriesBucket, StallEvaluation, Timeline } from "./types.ts";

const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;
/** The narrowest width keeping the series within MAX_BUCKETS wins; a week of hours, ~5 months of days. */
const BUCKET_WIDTHS = [MS_PER_HOUR, MS_PER_DAY, MS_PER_WEEK] as const;
const MAX_BUCKETS = 168;
const TOP_PATHS = 10;
const TOP_CONTACTS = 5;
/** Each cohort is a third of the landed work contacts; below this a third is anecdote, not a cohort. */
const MIN_COHORT = 3;

const STALL_CAVEAT = "Missions whose samples carry no problem (logs and producers from before it was recorded) count every quota hold as quota, provider rate limits included. Capacity waits and Recovery deferrals are timed from the events the board appends: nothing before they were recorded counts, and board downtime inside an open wait does. Launch refusals count only attempts that failed. Producer review failures can include provider-capacity failures. Offline, problem and deferral time can overlap.";

/** Union of the time declared contacts were queued or live; throughput per active hour excludes idle stretches. */
export function evaluateActivity(result: Evaluation, timelines: readonly Timeline[], clock: number, elapsed: number): void {
  const spans = timelines
    .flatMap(({ state }) => state.busySpans.map(span => [span.from, span.to ?? clock] as const))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let activeMs = 0;
  let covered = -Infinity;
  for (const [from, to] of spans) {
    if (to <= covered) continue;
    activeMs += to - Math.max(from, covered);
    covered = to;
  }
  result.activity = {
    activeMs,
    idleMs: Math.max(0, elapsed - activeMs),
    deliveriesPerActiveHour: activeMs > 0 ? result.deliveredWork * MS_PER_HOUR / activeMs : null,
  };
}

/** Dense launches/deliveries/land attempts/conflicts/review failures per UTC epoch-aligned bucket from creation to the clock. */
export function evaluateSeries(result: Evaluation, timelines: readonly Timeline[], fold: FoldEvaluation, createdAt: number, clock: number): void {
  const landings: number[] = [];
  for (const { contact, state } of timelines) if (isWork(contact) && state.landed !== null) landings.push(state.landed);
  let from = Math.min(createdAt, clock);
  for (const hour of fold.series.keys()) from = Math.min(from, hour * MS_PER_HOUR);
  for (const at of landings) from = Math.min(from, at);
  const width = BUCKET_WIDTHS.find(ms => Math.floor(clock / ms) - Math.floor(from / ms) < MAX_BUCKETS) ?? MS_PER_WEEK;
  const last = Math.floor(clock / width);
  const truncated = last - Math.floor(from / width) >= MAX_BUCKETS;
  const first = truncated ? last - MAX_BUCKETS + 1 : Math.floor(from / width);
  const buckets: SeriesBucket[] = Array.from({ length: last - first + 1 }, (_, i) => ({
    at: (first + i) * width, launches: 0, deliveries: 0, landAttempts: 0, conflicts: 0, reviewFailures: 0,
  }));
  for (const [hour, counts] of fold.series) {
    const bucket = buckets[Math.floor(hour * MS_PER_HOUR / width) - first];
    if (!bucket) continue;
    bucket.launches += counts.launches;
    bucket.landAttempts += counts.landAttempts;
    bucket.conflicts += counts.conflicts;
    bucket.reviewFailures += counts.reviewFailures;
  }
  for (const at of landings) {
    const bucket = buckets[Math.floor(at / width) - first];
    if (bucket) bucket.deliveries++;
  }
  result.series = { bucketMs: width, truncated, buckets };
}

/** Mission problems by class, offline time, board capacity waits and recorded launch refusals, kept apart from review failures. */
export function evaluateStalls(result: Evaluation, timelines: readonly Timeline[], fold: FoldEvaluation, clock: number): void {
  const { capacity } = fold;
  const stalls: Required<StallEvaluation> = {
    quota: { ms: 0, episodes: 0 }, rateLimit: { ms: 0, episodes: 0 }, otherProblem: { ms: 0, episodes: 0 },
    offline: { ms: 0, episodes: 0 },
    capacityWait: { ms: capacity.ms + (capacity.from === null ? 0 : Math.max(0, clock - capacity.from)), episodes: capacity.episodes },
    recoveryDeferral: { ms: 0, episodes: 0, byKind: { capacity: 0, memory: 0, refused: 0 } },
    launchRefusals: { memory: 0, sessionCap: 0, refused: 0, gaveUp: 0 },
    reviewFailures: result.quality?.reviewFailures ?? null, caveat: STALL_CAVEAT,
  };
  for (const { state } of timelines) {
    for (const kind of ["quota", "rateLimit", "otherProblem"] as const) {
      stalls[kind].ms += state.stallMs[kind];
      stalls[kind].episodes += state.stallEpisodes[kind];
    }
    stalls.offline.ms += state.offlineMs ?? 0;
    stalls.offline.episodes += state.offlineEpisodes;
    for (const kind of RECOVERY_DEFERRALS) {
      stalls.recoveryDeferral.ms += state.deferralMs[kind];
      stalls.recoveryDeferral.byKind[kind] += state.deferralMs[kind];
    }
    stalls.recoveryDeferral.episodes += state.deferralEpisodes;
    stalls.launchRefusals.memory += state.refusals.memory;
    stalls.launchRefusals.sessionCap += state.refusals.sessionCap;
    stalls.launchRefusals.refused += state.refusals.refused;
    stalls.launchRefusals.gaveUp += state.refusals.gaveUp;
  }
  result.stalls = stalls;
}

/** Conflict rate, the most conflicting paths (from land-attempt paths) and contacts. */
export function evaluateConflicts(result: Evaluation, timelines: readonly Timeline[], fold: FoldEvaluation): void {
  const { attempts } = result;
  const paths = [...fold.conflictPaths]
    .sort(([a, x], [b, y]) => y.conflicts - x.conflicts || a.localeCompare(b))
    .slice(0, TOP_PATHS)
    .map(([path, row]) => ({ path, conflicts: row.conflicts, contacts: [...row.contacts].reverse() }));
  const contacts = timelines
    .filter(({ state }) => state.conflicts > 0)
    .map(({ contact, state }) => ({ ticket: contact.ticket, conflicts: state.conflicts, landAttempts: state.landAttempts }))
    .sort((a, b) => b.conflicts - a.conflicts || a.ticket.localeCompare(b.ticket))
    .slice(0, TOP_CONTACTS);
  result.conflicts = {
    rate: attempts.landAttempts > 0 ? attempts.conflicts / attempts.landAttempts : null,
    unpathed: fold.unpathedConflicts, paths, contacts, truncated: fold.droppedPaths > 0,
  };
}

function launchCohort(reports: readonly ContactReport[]): LaunchCohort {
  const n = reports.length;
  const total = (value: (report: ContactReport) => number) => reports.reduce((sum, report) => sum + value(report), 0);
  const prices = reports.flatMap(report => report.spend.costUsd === null ? [] : [report.spend.costUsd]);
  const reviewed = reports.flatMap(report => report.review === null ? [] : [report.review.rounds]);
  const landAttempts = total(report => report.conflicts.landAttempts);
  return {
    n, firstLaunchAt: reports[0]!.launchedAt!, lastLaunchAt: reports[n - 1]!.launchedAt!,
    medianUsd: distribution(prices).medianMs, priced: prices.length,
    medianActiveMs: distribution(reports.map(report => report.activeMs)).medianMs!,
    medianDeliveryMs: distribution(reports.map(report => Math.max(0, report.landedAt! - report.launchedAt!))).medianMs!,
    relaunchesPerContact: total(report => report.relaunches.total) / n,
    launchFailuresPerContact: total(report => report.launchFailures) / n,
    reviewRoundsPerContact: reviewed.length ? reviewed.reduce((sum, rounds) => sum + rounds, 0) / reviewed.length : null,
    reviewed: reviewed.length,
    conflictsPerLandAttempt: landAttempts > 0 ? total(report => report.conflicts.count) / landAttempts : null,
  };
}

/** Early vs recent: the first and last third of landed work contacts by first launch, from the per-contact reports. */
export function evaluateLaunchCohorts(result: Evaluation): void {
  const landed = (result.contacts ?? [])
    .filter(report => report.outcome === "landed" && report.launchedAt !== null && isWork(report))
    .sort((a, b) => a.launchedAt! - b.launchedAt!);
  const size = Math.floor(landed.length / 3);
  result.launchCohorts = size < MIN_COHORT ? null : { early: launchCohort(landed.slice(0, size)), recent: launchCohort(landed.slice(-size)) };
}
