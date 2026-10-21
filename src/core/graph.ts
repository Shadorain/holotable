import type { Derived, Operation } from "./types.ts";

/**
 * Tickets the contact still waits for. A closer waits for every other contact without listing them in
 * `blockedBy`, so contacts added later block it too. A conflict mission is part of its target's landing:
 * the target stands for it, and an abandoned one never holds the closer back.
 */
export function unmetBlockers(
  op: Operation,
  derived: Derived,
  ticket: string,
): string[] {
  const contact = op.contacts.find((c) => c.ticket === ticket);
  if (!contact) return [];
  if (contact.kind === "closer")
    return op.contacts.filter((c) => c.ticket !== ticket && c.kind !== "conflict" && !derived.contacts[c.ticket]?.landed).map((c) => c.ticket);
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
