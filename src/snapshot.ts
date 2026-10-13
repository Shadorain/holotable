import { foldEvents, liveCount } from "./core/fold.ts";
import { project } from "./core/projection.ts";
import type { ContactStatus, DeliveryProbe, Load, Owner, Projection, RecoveryWait, Settings } from "./core/types.ts";
import { readEvents } from "./store/events.ts";
import { readNotes } from "./store/notes.ts";
import { readOperationDoc } from "./store/operations.ts";

export interface ProjectionExtras {
  statuses?: Record<string, ContactStatus | null>;
  owners?: Record<string, Owner>;
  probes?: Record<string, DeliveryProbe | null>;
  /** Board-wide load across open operations; defaults to this operation alone. */
  load?: Load;
  /** Terminals the frontend stopped listing this pass (null = frontend does not list). */
  vanished?: ReadonlySet<string>;
  /** Tickets of decision contacts that currently have an open agent pane. */
  decisionPanes?: ReadonlySet<string>;
  /** File existence checks (because we don't parse the JSON here). */
}

export async function loadProjection(
  home: string,
  id: string,
  settings: Settings,
  now: number,
  extras: ProjectionExtras = {},
  recoveryWaits?: Readonly<Record<string, RecoveryWait>>,
): Promise<Projection> {
  const [doc, events, notes] = await Promise.all([readOperationDoc(home, id), readEvents(home, id), readNotes(home, id)]);
  const own = liveCount(doc.operation, foldEvents(events));
  return project({
    operation: doc.operation,
    project: doc.project === null ? null : { id: doc.project.id, name: doc.project.name },
    events,
    statuses: extras.statuses ?? {},
    owners: extras.owners ?? {},
    probes: extras.probes ?? {},
    notesText: notes.text === "" ? null : notes.text,
    load: extras.load ?? { live: own, open: own },
    cap: settings.cap,
    decisionPanes: extras.decisionPanes,
    vanished: extras.vanished,
    recoveryWaits,
    now,
  });
}


export function statusText(p: Projection): string {
  const queued = p.contacts.filter((c) => c.group === "queue").length;
  const attention = p.contacts.filter((c) => c.attention).length;
  return `holotable · ${p.operation.name} · ${p.header.open}/${p.header.cap} omp · ${queued} queued · ${attention} need you`;
}
