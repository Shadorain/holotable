import type { Derived, Operation } from "./types.ts";

/** Tickets in the contact's `blockedBy` that have no `landed` event yet. */
export function unmetBlockers(
  op: Operation,
  derived: Derived,
  ticket: string,
): string[] {
  const contact = op.contacts.find((c) => c.ticket === ticket);
  if (!contact) return [];
  return contact.blockedBy.filter((t) => !derived.contacts[t]?.landed);
}

/** First blockedBy cycle found, as a ticket path, or null when acyclic. */
export function findCycle(
  contacts: Array<{ ticket: string; blockedBy: string[] }>,
): string[] | null {
  const edges = new Map(contacts.map((c) => [c.ticket, c.blockedBy]));
  const mark = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (ticket: string): string[] | null => {
    const m = mark.get(ticket);
    if (m === 2) return null;
    if (m === 1) return [...stack.slice(stack.indexOf(ticket)), ticket];
    mark.set(ticket, 1);
    stack.push(ticket);
    for (const dep of edges.get(ticket) ?? []) {
      const hit = visit(dep);
      if (hit) return hit;
    }
    stack.pop();
    mark.set(ticket, 2);
    return null;
  };
  for (const c of contacts) {
    const hit = visit(c.ticket);
    if (hit) return hit;
  }
  return null;
}
