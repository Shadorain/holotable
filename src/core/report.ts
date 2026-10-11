import { foldEvents, liveCount } from "./fold.ts";
import { countTasks } from "./notes.ts";
import { computeStats } from "./stats.ts";
import type { Contact, Event, Operation, Stats } from "./types.ts";

const MAX_BRIEF = 2000;
const MAX_NOTES = 4000;

export interface ReportContact {
  ticket: string;
  title: string | null;
  zone: string;
  kind: string;
  final: "landed" | "aborted" | "not-launched";
  landedVia: "merge" | "pr" | "manual" | null;
  landedAt: string | null;
  trackerUrl: string | null;
  prUrl: string | null;
}

export interface OperationReport {
  v: 1;
  id: string;
  name: string;
  repo: string;
  base: string;
  outcome: "landed" | "abandoned" | "decision" | "failed";
  createdAt: string;
  closedAt: string;
  durationMs: number;
  counts: { contacts: number; landed: number; conflicts: number; launches: number; landAttempts: number };
  contacts: ReportContact[];
  stats: Stats;
  /** Task lines in notes.md at close. */
  notes: { done: number; total: number };
  /** notes.md at close, first 4000 chars; null when the operation kept no notes. */
  notesText: string | null;
  brief: string | null;
}

/**
 * The archive record, computed from operation.json + events.jsonl alone (plus the brief text).
 * `closedAt` is the `closed` event when present (archives built retroactively use `now`).
 */
export function buildReport(
  operation: Operation,
  events: Event[],
  now: Date,
  brief: string | null = null,
  notesText: string | null = null,
): OperationReport {
  const closed = events.find((e) => e.kind === "closed");
  const closedAt = closed?.at ?? now.toISOString();
  // Rebuilt archives measure durations to close time, not the moment of reading.
  const clock = Date.parse(closedAt);
  const derived = foldEvents(events);
  const live = liveCount(operation, derived);

  const contacts: ReportContact[] = operation.contacts.map((contact) => {
    const d = derived.contacts[contact.ticket];
    let landing: Extract<Event, { kind: "landed" }> | undefined;
    for (let i = events.length - 1; i >= 0 && !landing; i -= 1) {
      const e = events[i];
      if (e.kind === "landed" && e.contact === contact.ticket) landing = e;
    }
    return {
      ticket: contact.ticket,
      title: contact.title,
      zone: contact.zone,
      kind: contact.kind,
      final: (d?.landed ?? false) ? "landed" : contact.lane ? "aborted" : "not-launched",
      landedVia: landing?.via ?? null,
      landedAt: landing?.at ?? null,
      trackerUrl: d?.lastSample?.tracker?.url ?? null,
      prUrl: d?.lastSample?.delivery?.url ?? null,
    };
  });

  const stats = computeStats(derived, clock, live);
  return {
    v: 1,
    id: operation.id,
    name: operation.name,
    repo: operation.repo,
    base: operation.base,
    outcome: closed?.kind === "closed" ? closed.outcome : "abandoned",
    createdAt: operation.createdAt,
    closedAt,
    durationMs: Math.max(0, Date.parse(closedAt) - Date.parse(operation.createdAt)),
    counts: {
      contacts: operation.contacts.length,
      landed: contacts.filter((c) => c.final === "landed").length,
      conflicts: events.filter((e) => e.kind === "land-attempt" && e.outcome === "conflict").length,
      launches: events.filter((e) => e.kind === "launched").length,
      landAttempts: events.filter((e) => e.kind === "land-attempt").length,
    },
    contacts,
    stats,
    notes: countTasks(notesText),
    notesText: notesText === null ? null : notesText.slice(0, MAX_NOTES),
    brief: brief === null ? null : brief.slice(0, MAX_BRIEF),
  };
}

/** Duck-type check for a persisted report; a malformed one is rebuilt from the archive's files. */
export function isReport(value: unknown): value is OperationReport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.v === 1 && typeof v.id === "string" && typeof v.outcome === "string" && typeof v.closedAt === "string";
}
