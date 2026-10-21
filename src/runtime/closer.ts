import { closerBrief } from "../core/closer.ts";
import { evaluateOperation } from "../core/evaluation.ts";
import { foldEvents } from "../core/fold.ts";
import type { Contact, Operation } from "../core/types.ts";
import { readBrief } from "../store/brief.ts";
import { closerReportPath } from "../store/closer.ts";
import { readEvents } from "../store/events.ts";
import { readNotes } from "../store/notes.ts";

/** The closer's review brief from what the board holds now: brief, notes, events and Intel's advice. */
export async function closerBriefFor(home: string, operation: Operation, closer: Contact, now: number): Promise<string> {
  const [events, notes, brief] = await Promise.all([readEvents(home, operation.id), readNotes(home, operation.id), readBrief(home, operation.id)]);
  const { recommendations } = evaluateOperation(operation, foldEvents(events), now);
  return closerBrief({
    operation,
    closer,
    events,
    briefText: brief.brief,
    notesText: notes.text === "" ? null : notes.text,
    recommendations: recommendations.map((r) => r.message),
    reportPath: closerReportPath(home, operation.id, closer.ticket),
  });
}
