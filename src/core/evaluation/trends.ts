import { isWork, MS_PER_HOUR } from "./shared.ts";
import type { Evaluation, FoldEvaluation, SeriesBucket, Timeline } from "./types.ts";

const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;
/** The narrowest width keeping the series within MAX_BUCKETS wins; a week of hours, ~5 months of days. */
const BUCKET_WIDTHS = [MS_PER_HOUR, MS_PER_DAY, MS_PER_WEEK] as const;
const MAX_BUCKETS = 168;
const TOP_PATHS = 10;
const TOP_CONTACTS = 5;

const STALL_CAVEAT = "Quota time is the mission's quota hold, which the producer also uses for provider rate limits. Events record neither the problem kind nor retryAt, and board capacity waits (auto mode waiting for provider capacity, recovery deferring a relaunch for memory or session slots) are never appended, so their duration is unmeasured; launch refusals count only attempts that failed. Producer review failures can include provider-capacity failures. Offline and quota time can overlap.";

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

/** Quota holds, offline time and recorded launch refusals, kept apart from review failures. */
export function evaluateStalls(result: Evaluation, timelines: readonly Timeline[]): void {
  const stalls = {
    quota: { ms: 0, episodes: 0 }, offline: { ms: 0, episodes: 0 },
    launchRefusals: { memory: 0, sessionCap: 0, refused: 0, gaveUp: 0 },
    reviewFailures: result.quality?.reviewFailures ?? null, caveat: STALL_CAVEAT,
  };
  for (const { state } of timelines) {
    stalls.quota.ms += state.holdMs.quota ?? 0;
    stalls.quota.episodes += state.quotaEpisodes;
    stalls.offline.ms += state.offlineMs ?? 0;
    stalls.offline.episodes += state.offlineEpisodes;
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
