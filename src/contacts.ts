import { CLOSER_TITLE, closerOf } from "./core/closer.ts";
import { unmetBlockers } from "./core/graph.ts";
import type { Contact, Kind, Operation, Source } from "./core/types.ts";
import { normalizeTicket } from "./core/validate-operation.ts";
import { appendEvent, readFolded } from "./store/events.ts";
import { mutateOperation } from "./store/operations.ts";

export interface NewContact {
  ticket: string;
  /** Required except for a closer, which defaults to the last zone (a new "Closer" zone when there is none). */
  zone?: string;
  kind?: Kind;
  blockedBy?: string[];
  title?: string | null;
  description?: string | null;
  /** Decision contacts only: the options the operator or agent may pick from. */
  options?: string[];
  /** Decision contacts only: the board's suggested option. */
  recommended?: string;
  /** Realpath of an existing checkout to adopt instead of queueing. */
  worktree?: string | null;
  /** Who is adding it; recorded on the event so the board can say where a contact came from. */
  source?: Source;
}
export interface ContactPatch {
  zone?: string;
  kind?: Kind;
  blockedBy?: string[];
  title?: string | null;
  description?: string | null;
  options?: string[];
  recommended?: string;
}

/**
 * `queued` per ticket, plus `blocked` when blockers are not yet landed. A waiting closer is blocked
 * again with the new tickets among its blockers: it waits for everything, including later additions.
 */
export async function queueEvents(home: string, now: Date, op: Operation, tickets: string[], source: Source): Promise<void> {
  const { derived } = await readFolded(home, op.id);
  const at = now.toISOString();
  for (const ticket of tickets) {
    await appendEvent(home, op.id, { v: 1, at, kind: "queued", contact: ticket, source });
    const by = unmetBlockers(op, derived, ticket);
    if (by.length) await appendEvent(home, op.id, { v: 1, at, kind: "blocked", contact: ticket, by });
  }
  const closer = closerOf(op);
  if (closer && !tickets.includes(closer.ticket) && closer.lane === null && !derived.contacts[closer.ticket]?.landed) {
    const by = unmetBlockers(op, derived, closer.ticket);
    if (tickets.some((t) => by.includes(t))) await appendEvent(home, op.id, { v: 1, at, kind: "blocked", contact: closer.ticket, by });
  }
}

/** A closer's zone when none is given: the last zone, or a new "Closer" zone in an operation with none. */
function closerZone(op: Operation): { zone: string; zones: Operation["zones"] } {
  const last = op.zones.at(-1);
  if (last) return { zone: last.id, zones: op.zones };
  return { zone: "closer", zones: [{ id: "closer", label: "Closer" }] };
}

export async function addContact(
  home: string,
  now: Date,
  opId: string,
  input: NewContact,
): Promise<{ ticket: string; adopted: boolean }> {
  let ticket = input.ticket;
  const next = await mutateOperation(home, opId, (op) => {
    ticket = normalizeTicket(op.tracker, input.ticket);
    const kind = input.kind ?? "implement";
    const placed = kind === "closer" && input.zone === undefined ? closerZone(op) : { zone: input.zone as string, zones: op.zones };
    const contact: Contact = {
      ticket,
      title: input.title ?? (kind === "closer" ? CLOSER_TITLE : null),
      description: input.description ?? null,
      zone: placed.zone,
      kind,
      blockedBy: (input.blockedBy ?? []).map((t) => normalizeTicket(op.tracker, t)),
      ...(input.options !== undefined ? { options: input.options } : {}),
      ...(input.recommended !== undefined ? { recommended: input.recommended } : {}),
      conflictOf: null,
      lane: input.worktree
        ? { worktree: input.worktree, branch: null, frontend: "external", terminal: null }
        : null,
    };
    return { ...op, zones: placed.zones, contacts: [...op.contacts, contact] };
  });
  if (input.worktree)
    await appendEvent(home, opId, { v: 1, at: now.toISOString(), kind: "adopted", contact: ticket, worktree: input.worktree, source: input.source ?? "operator" });
  else await queueEvents(home, now, next, [ticket], input.source ?? "operator");
  return { ticket, adopted: Boolean(input.worktree) };
}

export class ContactLaunchedError extends Error {
  readonly code = "contact-launched";
  constructor(ticket: string) {
    super(`contact-launched: ${ticket} already has a lane; only queued contacts can be changed`);
  }
}

/** Edit a queued contact. A launched contact is the mission's, not the queue's. */
export async function updateContact(
  home: string,
  now: Date,
  opId: string,
  rawTicket: string,
  patch: ContactPatch,
  source: Source,
): Promise<Contact> {
  let ticket = rawTicket;
  let blockersChanged = false;
  const next = await mutateOperation(home, opId, (op) => {
    ticket = normalizeTicket(op.tracker, rawTicket);
    const index = op.contacts.findIndex((c) => c.ticket === ticket);
    const current = op.contacts[index];
    if (!current) throw new Error(`No contact "${ticket}" in ${opId}`);
    if (current.lane) throw new ContactLaunchedError(ticket);
    const blockedBy = patch.blockedBy?.map((t) => normalizeTicket(op.tracker, t));
    blockersChanged = blockedBy !== undefined;
    const updated: Contact = {
      ...current,
      ...(patch.zone !== undefined ? { zone: patch.zone } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(blockedBy !== undefined ? { blockedBy } : {}),
      ...(patch.options !== undefined ? { options: patch.options } : {}),
      ...(patch.recommended !== undefined ? { recommended: patch.recommended } : {}),
    };
    return { ...op, contacts: op.contacts.map((c, i) => (i === index ? updated : c)) };
  });
  const contact = next.contacts.find((c) => c.ticket === ticket) as Contact;
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k]) => (k === "blockedBy" ? "blockers" : k));
  if (fields.length) await appendEvent(home, opId, { v: 1, at: now.toISOString(), kind: "edited", contact: ticket, source, fields });
  if (blockersChanged) {
    const { derived } = await readFolded(home, opId);
    const by = unmetBlockers(next, derived, ticket);
    if (by.length) await appendEvent(home, opId, { v: 1, at: now.toISOString(), kind: "blocked", contact: ticket, by });
  }
  return contact;
}
