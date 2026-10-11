import type {
  ContactDerived,
  Derived,
  Event,
  Operation,
} from "./types.ts";

export function emptyContactDerived(): ContactDerived {
  return {
    queuedAt: null,
    launchedAt: null,
    landed: false,
    landedAt: null,
    reaped: false,
    lastPhase: null,
    phaseSpans: [],
    gateSpans: [],
    socketEver: false,
    socketUp: false,
    downSpans: [],
    landAttempts: 0,
    lastSample: null,
    conflicts: 0,
    launchFailed: null,
    lastOmp: null,
    removed: false,
    decision: null,
  };
}

/** Derived view for one contact; missing ticket yields an empty record. */
export function contactDerived(derived: Derived, ticket: string): ContactDerived {
  return derived.contacts[ticket] ?? emptyContactDerived();
}

/**
 * Replay `events` into per-contact derived state and operation-level counters.
 * Assumes the append-only order of `events`; open spans stay `to: null` and
 * callers close them against their clock.
 */
export function foldEvents(events: Event[]): Derived {
  const derived: Derived = {
    contacts: {},
    peakOmp: 0,
    closed: false,
  };
  const at = (e: Event): number => Date.parse(e.at);
  const openPhase = (d: ContactDerived) =>
    d.phaseSpans[d.phaseSpans.length - 1]?.to === null
      ? d.phaseSpans[d.phaseSpans.length - 1]
      : null;
  // Terminal events close open spans so stats stop growing after work ends.
  const closeSpans = (d: ContactDerived, t: number) => {
    const p = d.phaseSpans[d.phaseSpans.length - 1];
    if (p && p.to === null) p.to = t;
    const g = d.gateSpans[d.gateSpans.length - 1];
    if (g && g.to === null) g.to = t;
    const s = d.downSpans[d.downSpans.length - 1];
    if (s && s.to === null) s.to = t;
  };
  for (const e of events) {
    // Legacy "workflow" ticks fold to nothing: notes.md replaced the checklist.
    if (e.kind === "closed") {
      derived.closed = true;
      const t = at(e);
      for (const d of Object.values(derived.contacts)) closeSpans(d, t);
      continue;
    }
    if (!("contact" in e)) continue;
    const d =
      derived.contacts[e.contact] ??
      (derived.contacts[e.contact] = emptyContactDerived());
    const t = at(e);
    switch (e.kind) {
      case "queued":
        if (d.queuedAt === null) d.queuedAt = t;
        break;
      case "launched":
        if (d.launchedAt === null) d.launchedAt = t;
        // A relaunch records a fresh `launched`: the recorded terminal is alive again.
        d.reaped = false;
        d.launchFailed = null;
        break;
      case "landed":
        d.landed = true;
        if (d.landedAt === null) d.landedAt = t;
        closeSpans(d, t);
        break;
      case "reaped":
        d.reaped = true;
        closeSpans(d, t);
        break;
      case "removed":
        d.removed = true;
        closeSpans(d, t);
        break;
      case "phase": {
        // Close whatever span is open (or the armed gate) at this timestamp.
        const p = openPhase(d);
        if (p) p.to = t;
        d.phaseSpans.push({ phase: e.to, from: t, to: null });
        const g = d.gateSpans[d.gateSpans.length - 1];
        if (g && g.to === null) g.to = t;
        d.lastPhase = e.to;
        break;
      }
      case "gate-armed": {
        const g = d.gateSpans[d.gateSpans.length - 1];
        if (g && g.to === null) g.to = t;
        d.gateSpans.push({ gate: e.gate, from: t, to: null });
        break;
      }
      case "decided": {
        d.decision = { choice: e.choice, rationale: e.rationale ?? null, by: e.by, at: e.at };
        break;
      }
      case "operator": {
        if (e.op === "approve" && e.ok) {
          const g = d.gateSpans[d.gateSpans.length - 1];
          if (g && g.to === null) g.to = t;
        }
        break;
      }
      case "socket-up": {
        d.socketEver = true;
        d.socketUp = true;
        const s = d.downSpans[d.downSpans.length - 1];
        if (s && s.to === null) s.to = t;
        break;
      }
      case "socket-down": {
        d.socketUp = false;
        const s = d.downSpans[d.downSpans.length - 1];
        if (!s || s.to !== null) d.downSpans.push({ from: t, to: null });
        break;
      }
      case "land-attempt":
        d.landAttempts += 1;
        if (e.outcome === "conflict") d.conflicts += 1;
        break;
      case "launch-failed":
        d.launchFailed = { step: e.step, error: e.error };
        break;
      case "sample": {
        // Merge fields: tracker and delivery arrive in different samples.
        d.lastSample = {
          ...(d.lastSample ?? {}),
          ...(e.tracker !== undefined ? { tracker: e.tracker } : {}),
          ...(e.delivery !== undefined ? { delivery: e.delivery } : {}),
          ...(e.workers !== undefined ? { workers: e.workers } : {}),
          ...(e.omp !== undefined ? { omp: e.omp } : {}),
          // Usage is a changing-cost sample: keep the newest, never sum events.
          ...(e.usage !== undefined ? { usage: e.usage } : {}),
        };
        if (e.omp !== undefined) {
          d.lastOmp = e.omp;
          if (e.omp > derived.peakOmp) derived.peakOmp = e.omp;
        }
        break;
      }
      default:
        break;
    }
  }
  return derived;
}

/** Contacts whose terminal exists and has not been reaped. */
export function liveCount(op: Operation, derived: Derived): number {
  let n = 0;
  for (const c of op.contacts) {
    if (c.lane?.terminal && !contactDerived(derived, c.ticket).reaped) n += 1;
  }
  return n;
}
