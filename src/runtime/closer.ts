import { closerBrief, closerCoverage, closerTickets } from "../core/closer.ts";
import { evaluateOperation } from "../core/evaluation.ts";
import { foldEvents } from "../core/fold.ts";
import type { CloserCoverage, CloserReview, Contact, Event, Operation } from "../core/types.ts";
import { readBrief } from "../store/brief.ts";
import { closerReportPath, closerReviewPath, readCloserReport, readCloserReview } from "../store/closer.ts";
import { readEvents } from "../store/events.ts";
import { readNotes } from "../store/notes.ts";

export interface CloserView {
  ticket: string;
  brief: string;
  /** The Markdown copy; the card renders it only when there is no JSON review. */
  report: string | null;
  review: CloserReview | null;
  /** Why closer/<ticket>.json, though written, could not be read as a review. */
  reviewError: string | null;
  /** Every landed ticket against the review's verdicts; null until a review exists. */
  coverage: CloserCoverage | null;
}

async function briefFrom(home: string, operation: Operation, closer: Contact, events: Event[], now: number): Promise<string> {
  const [notes, brief] = await Promise.all([readNotes(home, operation.id), readBrief(home, operation.id)]);
  const { recommendations } = evaluateOperation(operation, foldEvents(events), now);
  return closerBrief({
    operation,
    closer,
    events,
    briefText: brief.brief,
    notesText: notes.text === "" ? null : notes.text,
    recommendations: recommendations.map((r) => r.message),
    reportPath: closerReviewPath(home, operation.id, closer.ticket),
    markdownPath: closerReportPath(home, operation.id, closer.ticket),
  });
}

/** The closer's review brief from what the board holds now: brief, notes, events and Intel's advice. */
export async function closerBriefFor(home: string, operation: Operation, closer: Contact, now: number): Promise<string> {
  return briefFrom(home, operation, closer, await readEvents(home, operation.id), now);
}

/** What the closer's card shows: its brief as it would launch now, its report, and ticket coverage. */
export async function closerView(home: string, operation: Operation, closer: Contact, now: number): Promise<CloserView> {
  const events = await readEvents(home, operation.id);
  const [brief, report, { review, error }] = await Promise.all([
    briefFrom(home, operation, closer, events, now),
    readCloserReport(home, operation.id, closer.ticket),
    readCloserReview(home, operation.id, closer.ticket),
  ]);
  const coverage = review ? closerCoverage(closerTickets(operation, foldEvents(events), closer.ticket), review) : null;
  return { ticket: closer.ticket, brief, report, review, reviewError: error, coverage };
}
