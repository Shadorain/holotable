import { closerBrief, closerCoverage, closerTickets } from "../core/closer.ts";
import { evaluateOperation } from "../core/evaluation.ts";
import { foldEvents } from "../core/fold.ts";
import type { CloserCoverage, CloserReview, Contact, Derived, Event, Operation } from "../core/types.ts";
import type { ArchiveEntry } from "../store/archive.ts";
import { readBrief } from "../store/brief.ts";
import { closerReportPath, closerReviewPath, readCloserFiles, type CloserFiles } from "../store/closer.ts";
import { readFolded } from "../store/events.ts";
import { readNotes } from "../store/notes.ts";

/** What the closer reported, open or archived. */
export interface CloserReportView {
  ticket: string;
  /** The Markdown copy; shown only when there is no JSON review. */
  report: string | null;
  review: CloserReview | null;
  /** Why closer/<ticket>.json, though written, could not be read as a review. */
  reviewError: string | null;
  /** Every landed ticket against the review's verdicts; null until a review exists. */
  coverage: CloserCoverage | null;
}

export interface CloserView extends CloserReportView {
  brief: string;
}

async function briefFrom(home: string, operation: Operation, closer: Contact, events: Event[], derived: Derived, now: number): Promise<string> {
  const [notes, brief] = await Promise.all([readNotes(home, operation.id), readBrief(home, operation.id)]);
  const { recommendations } = evaluateOperation(operation, derived, now);
  return closerBrief({
    operation,
    closer,
    events,
    derived,
    briefText: brief.brief,
    notesText: notes.text === "" ? null : notes.text,
    recommendations: recommendations.map((r) => r.message),
    reportPath: closerReviewPath(home, operation.id, closer.ticket),
    markdownPath: closerReportPath(home, operation.id, closer.ticket),
  });
}

function reportView(operation: Operation, closer: Contact, derived: Derived, files: CloserFiles): CloserReportView {
  const coverage = files.review ? closerCoverage(closerTickets(operation, derived, closer.ticket), files.review) : null;
  return { ticket: closer.ticket, report: files.report, review: files.review, reviewError: files.error, coverage };
}

/** The closer's review brief from what the board holds now: brief, notes, events and Intel's advice. */
export async function closerBriefFor(home: string, operation: Operation, closer: Contact, now: number): Promise<string> {
  const { events, derived } = await readFolded(home, operation.id);
  return briefFrom(home, operation, closer, events, derived, now);
}

/** What the closer's card shows: its brief as it would launch now, its report, and ticket coverage. */
export async function closerView(home: string, operation: Operation, closer: Contact, now: number): Promise<CloserView> {
  const { events, derived } = await readFolded(home, operation.id);
  const [brief, files] = await Promise.all([briefFrom(home, operation, closer, events, derived, now), readCloserFiles(home, operation.id, closer.ticket)]);
  return { ...reportView(operation, closer, derived, files), brief };
}

/** A closed operation's closer report with coverage, from its archive; null when it had no closer. */
export function archivedCloserView(entry: ArchiveEntry): CloserReportView | null {
  if (!entry.operation || !entry.closer) return null;
  return reportView(entry.operation, entry.closer.contact, foldEvents(entry.events), entry.closer.files);
}
