import type { ActionRequest } from "../board.ts";
import { loadProjection, type ProjectionExtras } from "../snapshot.ts";
import { foldEvents } from "../core/fold.ts";
import type { ContactStatus, ContactView, Event, Projection, RecoveryWait, Settings } from "../core/types.ts";
import { appendEvent, readEvents } from "../store/events.ts";
import { listOperations } from "../store/operations.ts";
import { ActionError } from "./errors.ts";
import { memoryLaunchRefusal } from "../core/policy.ts";

export interface RecoverDeps {
  home: string;
  now(): Date;
  settings(): Promise<Settings>;
  extras(opId: string): Required<ProjectionExtras>;
  /** The same runner operator clicks use; recovery requests carry `by: "recover"`. */
  run(req: ActionRequest): Promise<void>;
  /** Internal failures (store reads, projection); action failures are already on the log. */
  warn(message: string): void;
  availableMemory?(): number | null;
  settle?(opId: string): Promise<void>;
}

/** A crashed pane deserves a few tries, not a launch loop. */
const MAX_RELAUNCHES = 3;
const RELAUNCH_WINDOW_MS = 30 * 60 * 1000;
/** `continue` takes the ownership lock, which stays stale ~30 s after a crash (ELOCKED until then). */
const CONTINUE_RETRY_MS = 30 * 1000;
/** A stale watcher pass must not replace a child whose startup is still in flight. */
const RELAUNCH_GRACE_MS = 60 * 1000;
/** A refused automatic relaunch (a pane in the way, a live socket) is retried this long after, never counted as a crash. */
const REFUSAL_RETRY_MS = 5 * 60 * 1000;

interface Recovery {
  /** Recover-driven relaunches inside the window, after the last operator relaunch reset the count. */
  relaunches: number;
  /** The gave-up marker already recorded since the last operator relaunch. */
  gaveUp: boolean;
  /** When recovery last sent continue for this contact (pacing across restarts). */
  lastContinueAt: number;
  /** The newest refused automatic relaunch since the last operator relaunch: a wait, not a crash. */
  refusal: { at: number; error: string } | null;
}

function recovery(events: Event[], ticket: string, now: number): Recovery {
  const since = now - RELAUNCH_WINDOW_MS;
  // An operator relaunch (any by but "recover") is the human taking over: it resets the crash count.
  const lastReset = events.reduce(
    (acc, e) => (e.kind === "operator" && e.contact === ticket && e.op === "relaunch" && e.by !== "recover" ? Math.max(acc, Date.parse(e.at)) : acc),
    0,
  );
  const relaunches = events.filter(
    (e): e is Extract<Event, { kind: "operator" }> =>
      e.kind === "operator" &&
      e.contact === ticket &&
      e.op === "relaunch" &&
      e.by === "recover" &&
      Date.parse(e.at) > lastReset,
  );
  // A refusal or a resource wait never opened a pane, so it is not a crash; only real attempts spend the budget.
  const waited = (e: Extract<Event, { kind: "operator" }>) =>
    e.error?.startsWith("memory-pressure:") === true || e.error?.startsWith("refused:") === true;
  const relaunchEvents = relaunches.filter((e) => !waited(e) && Date.parse(e.at) >= since);
  const refused = relaunches.filter((e) => e.error?.startsWith("refused:") === true && !e.error.startsWith("refused: cap ")).at(-1);
  const lastContinueAt = events.reduce(
    (acc, e) => (e.kind === "operator" && e.contact === ticket && e.op === "continue" && e.by === "recover" ? Math.max(acc, Date.parse(e.at)) : acc),
    0,
  );
  return {
    relaunches: relaunchEvents.length,
    gaveUp: relaunchEvents.some((e) => e.ok === false && e.error?.startsWith("gave up:") === true),
    lastContinueAt,
    refusal: refused ? { at: Date.parse(refused.at), error: refused.error!.slice("refused: ".length) } : null,
  };
}

/**
 * A dead pane Recovery brings back: offline with its pane vanished or its process gone, not reaped,
 * not finished, and not parked on quota or an unanswered question.
 */
function deadPane(contact: ContactView, status: ContactStatus | null, extras: Required<ProjectionExtras>, reaped: boolean): boolean {
  if (status?.hold === "quota" || status?.hold === "question") return false;
  const lane = contact.lane;
  if (contact.state !== "offline" || lane === null || !lane.terminal) return false;
  // A pane whose process is alive stays observed/offline until its status window expires.
  if (!extras.vanished.has(contact.ticket) && !extras.gone.has(contact.ticket)) return false;
  return !reaped && !status?.complete;
}

/**
 * Contacts Recovery will relaunch once their startup grace and a session slot allow. Auto launch leaves
 * them their slots: otherwise a crashed mission's slot goes to new work while it waits out the grace.
 * A contact whose last restart was refused is not reserved for: the refusal can last (a pane someone reopened).
 */
export function relaunchesPending(projection: Projection, extras: Required<ProjectionExtras>, events: Event[], now: number): string[] {
  if (projection.operation.recover !== true) return [];
  const folded = foldEvents(events);
  return projection.contacts
    .filter((c) => {
      if (!deadPane(c, extras.statuses[c.ticket] ?? null, extras, folded.contacts[c.ticket]?.reaped === true)) return false;
      const state = recovery(events, c.ticket, now);
      return state.relaunches < MAX_RELAUNCHES && !(state.refusal && now - state.refusal.at < REFUSAL_RETRY_MS) &&
        c.actions.some((a) => a.id === "relaunch" && a.enabled);
    })
    .map((c) => c.ticket);
}

export function createRecover(deps: RecoverDeps): { pass(): Promise<void>; deferred(opId: string): Readonly<Record<string, RecoveryWait>> } {
  // Relaunch waits on a control socket for up to 90 s; one attempt per contact at a time.
  const busy = new Set<string>();
  // Each relaunch spawns the frontend CLI and a pane; a whole operation dying at once must not run them all
  // together (the board's service cgroup caps threads, and the CLI fails with EAGAIN past it).
  const queued = new Set<string>();
  const deferred = new Map<string, Record<string, RecoveryWait>>();
  const empty: Readonly<Record<string, RecoveryWait>> = {};
  function defer(opId: string, ticket: string, wait: RecoveryWait): void {
    let waits = deferred.get(opId);
    if (!waits) deferred.set(opId, waits = {});
    waits[ticket] = wait;
  }
  let relaunchChain: Promise<void> = Promise.resolve();
  function enqueueRelaunch(opId: string, ticket: string): void {
    const key = `${opId}/${ticket}`;
    if (queued.has(key) || busy.has(key)) return;
    queued.add(key);
    relaunchChain = relaunchChain.then(async () => {
      const extras = deps.extras(opId);
      const projection = await loadProjection(deps.home, opId, await deps.settings(), deps.now().getTime(), extras);
      const folded = foldEvents(await readEvents(deps.home, opId));
      const contact = projection.contacts.find(c => c.ticket === ticket);
      if (!projection.operation.recover || folded.closed || folded.contacts[ticket]?.reaped ||
          contact?.state !== "offline" || !contact.lane?.terminal || extras.statuses[ticket]?.hold === "quota" || extras.statuses[ticket]?.hold === "question") return;
      if (projection.header.open >= projection.header.cap) {
        defer(opId, ticket, { kind: "capacity", detail: `Waiting for a session slot (${projection.header.open}/${projection.header.cap})` });
        return;
      }
      const memory = memoryLaunchRefusal(deps.availableMemory?.() ?? null);
      if (memory) {
        defer(opId, ticket, { kind: "memory", detail: `Waiting for memory · ${memory}` });
        return;
      }
      if (!contact.actions.some(a => a.id === "relaunch" && a.enabled)) return;
      await act(opId, ticket, "relaunch");
      if (deps.extras(opId).owners[ticket] === "live") delete deferred.get(opId)?.[ticket];
    }).catch(error => deps.warn(`recover ${opId}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => queued.delete(key));
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
      await deps.settle?.(opId);
    } catch (error) {
      if (error instanceof ActionError && error.code === "memory-pressure")
        defer(opId, ticket, { kind: "memory", detail: `Waiting for memory · ${error.message}` });
      else if (error instanceof ActionError && error.code === "refused" && error.message.startsWith("cap "))
        defer(opId, ticket, { kind: "capacity", detail: `Waiting for a session slot · ${error.message}` });
      if (!(error instanceof ActionError))
        deps.warn(`recover ${opId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy.delete(key);
    }
  }

  /** One operation: continue resume holds, then relaunch dead panes. */
  async function runOp(opId: string): Promise<void> {
    deferred.set(opId, {});
    const now = deps.now();
    const projection = await loadProjection(deps.home, opId, await deps.settings(), now.getTime(), deps.extras(opId));
    if (projection.operation.recover !== true) return;
    const extras = deps.extras(opId);
    const events = await readEvents(deps.home, opId);
    const folded = foldEvents(events);

    for (const contact of projection.contacts) {
      const status = extras.statuses[contact.ticket] ?? null;
      // Neither spend another turn against exhausted quota nor discard an unanswered prompt.
      if (status?.hold === "quota" || status?.hold === "question") continue;
      const state = recovery(events, contact.ticket, now.getTime());
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

      // An operator Reap means "leave it"; the only way back is the operator's own Relaunch.
      if (!deadPane(contact, status, extras, folded.contacts[contact.ticket]?.reaped === true)) continue;
      const freshAt = lastFreshAt(events, contact.ticket);
      if (freshAt !== null && now.getTime() - freshAt < RELAUNCH_GRACE_MS) continue;
      if (state.relaunches < MAX_RELAUNCHES) {
        if (state.refusal && now.getTime() - state.refusal.at < REFUSAL_RETRY_MS) {
          const at = new Date(state.refusal.at + REFUSAL_RETRY_MS).toISOString().slice(11, 16);
          defer(opId, contact.ticket, { kind: "refused", detail: `Restart refused (${state.refusal.error}); retrying at ${at} UTC` });
          continue;
        }
        if (queued.has(`${opId}/${contact.ticket}`)) {
          defer(opId, contact.ticket, { kind: "capacity", detail: "Restart queued" });
          continue;
        }
        const reserved = projection.header.open + queued.size;
        if (reserved >= projection.header.cap) {
          defer(opId, contact.ticket, { kind: "capacity", detail: `Waiting for a session slot (${reserved}/${projection.header.cap})` });
          continue;
        }
        const memory = memoryLaunchRefusal(deps.availableMemory?.() ?? null, queued.size);
        if (memory) {
          defer(opId, contact.ticket, { kind: "memory", detail: `Waiting for memory · ${memory}` });
          continue;
        }
        if (!contact.actions.some(a => a.id === "relaunch" && a.enabled)) continue;
        enqueueRelaunch(opId, contact.ticket);
      } else if (!state.gaveUp && contact.actions.some(a => a.id === "relaunch" && a.enabled)) {
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
    deferred: (opId) => deferred.get(opId) ?? empty,
    async pass(): Promise<void> {
      const rows = await listOperations(deps.home);
      for (const id of deferred.keys()) if (!rows.some(row => row.id === id)) deferred.delete(id);
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
