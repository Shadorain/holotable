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
  /** Uncommitted path count in the integration checkout (local-merge ops); null when not probed. */
  integrationDirty?: number | null;
  /** Terminals the frontend stopped listing this pass (null = frontend does not list). */
  vanished?: ReadonlySet<string>;
  /** Producers whose recorded process is provably dead (pid gone or start-time mismatch). */
  gone?: ReadonlySet<string>;
  /** Tickets of decision contacts that currently have an open agent pane. */
  decisionPanes?: ReadonlySet<string>;
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
    integrationDirty: extras.integrationDirty ?? null,
    recoveryWaits,
    now,
  });
}
