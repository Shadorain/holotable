import type { ActionRequest } from "../board.ts";
import { loadProjection, type ProjectionExtras } from "../snapshot.ts";
import { foldEvents } from "../core/fold.ts";
import type { Event, Settings } from "../core/types.ts";
import { appendEvent, readEvents } from "../store/events.ts";
import { listOperations } from "../store/operations.ts";
import { ActionError } from "./errors.ts";

export interface RecoverDeps {
  home: string;
  now(): Date;
  settings(): Promise<Settings>;
  extras(opId: string): Required<ProjectionExtras>;
  /** The same runner operator clicks use; recovery requests carry `by: "recover"`. */
  run(req: ActionRequest): Promise<void>;
  /** Internal failures (store reads, projection); action failures are already on the log. */
  warn(message: string): void;
}

/** A crashed pane deserves a few tries, not a launch loop. */
const MAX_RELAUNCHES = 3;
const RELAUNCH_WINDOW_MS = 30 * 60 * 1000;
/** `continue` takes the ownership lock, which stays stale ~30 s after a crash (ELOCKED until then). */
const CONTINUE_RETRY_MS = 30 * 1000;
/** A pane that still exists while its socket is dead this long means omp crashed or hung inside it. */
const OFFLINE_RELAUNCH_MS = 60 * 1000;

export function createRecover(deps: RecoverDeps): { pass(): Promise<void> } {
  // Relaunch waits on a control socket for up to 90 s; one attempt per contact at a time.
  const busy = new Set<string>();
  // Each relaunch spawns the frontend CLI and a pane; a whole operation dying at once must not run them all
  // together (the board's service cgroup caps threads, and the CLI fails with EAGAIN past it).
  const queued = new Set<string>();
  let relaunchChain: Promise<void> = Promise.resolve();
  function enqueueRelaunch(opId: string, ticket: string): void {
    const key = `${opId}/${ticket}`;
    if (queued.has(key) || busy.has(key)) return;
    queued.add(key);
    relaunchChain = relaunchChain.then(() => act(opId, ticket, "relaunch")).finally(() => queued.delete(key));
  }

  interface Recovery {
    /** Recover-driven relaunches inside the window, after the last operator relaunch reset the count. */
    relaunches: number;
    /** The gave-up marker already recorded since the last operator relaunch. */
    gaveUp: boolean;
    /** When recovery last sent continue for this contact (pacing across restarts). */
    lastContinueAt: number;
  }

  function recovery(events: Event[], ticket: string): Recovery {
    const since = deps.now().getTime() - RELAUNCH_WINDOW_MS;
    // An operator relaunch (any by but "recover") is the human taking over: it resets the crash count.
    const lastReset = events.reduce(
      (acc, e) => (e.kind === "operator" && e.contact === ticket && e.op === "relaunch" && e.by !== "recover" ? Math.max(acc, Date.parse(e.at)) : acc),
      0,
    );
    const relaunchEvents = events.filter(
      (e): e is Extract<Event, { kind: "operator" }> =>
        e.kind === "operator" &&
        e.contact === ticket &&
        e.op === "relaunch" &&
        e.by === "recover" &&
        Date.parse(e.at) >= since &&
        Date.parse(e.at) > lastReset,
    );
    const lastContinueAt = events.reduce(
      (acc, e) => (e.kind === "operator" && e.contact === ticket && e.op === "continue" && e.by === "recover" ? Math.max(acc, Date.parse(e.at)) : acc),
      0,
    );
    return {
      relaunches: relaunchEvents.length,
      gaveUp: relaunchEvents.some((e) => e.ok === false && e.error?.startsWith("gave up:") === true),
      lastContinueAt,
    };
  }

  /** When the socket last went down with nothing newer contradicting it; null when connected. */
  function socketDownSince(events: Event[], ticket: string): number | null {
    for (const e of [...events].reverse()) {
      if (!("contact" in e) || e.contact !== ticket) continue;
      if (e.kind === "socket-down") return Date.parse(e.at);
      if (e.kind === "socket-up" || e.kind === "launched" || e.kind === "reaped" || e.kind === "landed") return null;
    }
    return null;
  }

  /** Timestamp of the newest `launched`/`socket-up` for the ticket; null when none. */
  function lastFreshAt(events: Event[], ticket: string): number | null {
    for (const e of [...events].reverse()) {
      if (!("contact" in e) || e.contact !== ticket) continue;
      if (e.kind === "launched" || e.kind === "socket-up") return Date.parse(e.at);
      if (e.kind === "socket-down" || e.kind === "reaped" || e.kind === "landed") return null;
    }
    return null;
  }

  /** Fire a recover action; port/action failures land on the log through the runner, internal ones warn. */
  async function act(opId: string, ticket: string, action: string): Promise<void> {
    const key = `${opId}/${ticket}`;
    if (busy.has(key)) return;
    busy.add(key);
    try {
      await deps.run({ op: opId, contact: ticket, action, args: {}, by: "recover" });
    } catch (error) {
      if (!(error instanceof ActionError))
        deps.warn(`recover ${opId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy.delete(key);
    }
  }

  /** One operation: continue resume holds, then relaunch dead panes. */
  async function runOp(opId: string): Promise<void> {
    const now = deps.now();
    const projection = await loadProjection(deps.home, opId, await deps.settings(), now.getTime(), deps.extras(opId));
    if (projection.operation.recover !== true) return;
    const extras = deps.extras(opId);
    const events = await readEvents(deps.home, opId);
    const folded = foldEvents(events);

    for (const contact of projection.contacts) {
      const status = extras.statuses[contact.ticket] ?? null;
      const state = recovery(events, contact.ticket);
      if (
        status?.hold === "resume" &&
        contact.owner === "live" &&
        status.ctl !== null &&
        status.verify !== "failed" &&
        status.actions.includes("continue") &&
        now.getTime() - state.lastContinueAt >= CONTINUE_RETRY_MS
      ) {
        await act(opId, contact.ticket, "continue");
        continue;
      }

      // 2. Relaunch: pane gone from the frontend's list, or a listed pane whose owner died 60+ s ago.
      const lane = contact.lane;
      if (contact.state !== "offline" || lane === null || !lane.terminal) continue;
      // An operator Reap means "leave it"; the only way back is the operator's own Relaunch.
      if (folded.contacts[contact.ticket]?.reaped) continue;
      if (status?.complete) continue;
      const missing = extras.vanished.has(contact.ticket);
      const downSince = socketDownSince(events, contact.ticket);
      const hung = downSince !== null && now.getTime() - downSince >= OFFLINE_RELAUNCH_MS;
      if (!missing && !hung) continue;
      // A stale watcher pass can mark a just-relaunched pane vanished: give the
      // recorded launched/socket-up the socket-down window before killing it.
      if (missing && !hung) {
        const freshAt = lastFreshAt(events, contact.ticket);
        if (freshAt !== null && now.getTime() - freshAt < OFFLINE_RELAUNCH_MS) continue;
      }
      // A refused relaunch (cap full) would be logged as a failure and eat the crash-loop budget: wait instead.
      if (!contact.actions.some((a) => a.id === "relaunch" && a.enabled)) continue;
      if (state.relaunches < MAX_RELAUNCHES) {
        // Relaunch waits up to 90 s for the new socket; never hold the watcher loop for it.
        enqueueRelaunch(opId, contact.ticket);
      } else if (!state.gaveUp) {
        // Crash-loop: record the give-up once; an operator Relaunch resets the count.
        await appendEvent(deps.home, opId, {
          v: 1,
          at: now.toISOString(),
          kind: "operator",
          contact: contact.ticket,
          op: "relaunch",
          ok: false,
          error: `gave up: ${MAX_RELAUNCHES} relaunches in ${RELAUNCH_WINDOW_MS / 60_000} min`,
          by: "recover",
        });
      }
    }
  }

  return {
    async pass(): Promise<void> {
      const rows = await listOperations(deps.home);
      for (const row of rows) {
        try {
          await runOp(row.id);
        } catch (error) {
          deps.warn(`recover ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
