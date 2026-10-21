import { actionOf, canDo, contactOf } from "../core/projection.ts";
import type { ActionRequest } from "../board.ts";
import type { ContactView, Event, Operation, Settings } from "../core/types.ts";
import { messageOf } from "../core/errors.ts";
import { loadProjection, type ProjectionExtras } from "../snapshot.ts";
import { appendEvent, readEvents } from "../store/events.ts";
import { listOperations, mutateOperation, readOperation } from "../store/operations.ts";
import { ActionError } from "./errors.ts";
import { PortError } from "../ports.ts";
import { resolutionFor } from "./lander.ts";
import { relaunchesPending } from "./recover.ts";

/** Waits after consecutive failed automatic attempts on one contact; one more failure stops retrying it. */
const BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];
/** Land refusals auto mode treats as waits with their own pacing, not failures. */
const WAIT_CODES = ["integration-dirty", "integration-wrong-branch", "not-merged", "conflict-opened", "checks-pending", "branch-updated", "pr-opened"];
export const MAX_AUTO_CHECKS = 2;
const CHECK_SPACING_MS = 10 * 60_000;
const CHECK_STALE_MS = 45 * 60_000;

const autoAttempts = (events: Event[], ticket: string, op: string) =>
  events.filter((e) => e.kind === "operator" && e.contact === ticket && e.op === op && e.by === "auto");

/** Auto already switched this contact's mission to Force; later mode changes are the operator's. */
export const reviewsRequested = (events: Event[], ticket: string) =>
  events.some((e) => e.kind === "operator" && e.contact === ticket && e.op === "mode" && e.by === "auto" && e.ok &&
    e.args?.mode === "force");

/**
 * Whether automatic `op` on `ticket` may run at `now`, from the persisted event log so a restart keeps it:
 * consecutive failures back off 5, 15, then 60 minutes, and the next failure stops automatic retries.
 */
export function autoRetryAllowed(events: Event[], ticket: string, op: string, now: number): boolean {
  let failures = 0;
  let last = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "operator" || e.contact !== ticket || e.op !== op || e.by !== "auto") continue;
    if (e.ok) break;
    if (WAIT_CODES.some((code) => e.error?.startsWith(`${code}:`))) continue;
    if (failures === 0) last = Date.parse(e.at);
    failures++;
  }
  if (failures === 0) return true;
  if (failures > BACKOFF_MS.length) return false;
  return now >= last + BACKOFF_MS[failures - 1]!;
}

/**
 * Automatic Check PR requests for `ticket` since the base last moved (another contact landed). A move can
 * be what turned the checks red, or what fixes them, so it opens a fresh budget.
 */
export function autoChecksSinceBase(events: Event[], ticket: string): Event[] {
  const moved = events.reduce((at, e) => (e.kind === "landed" && "contact" in e && e.contact !== ticket ? Math.max(at, Date.parse(e.at)) : at), 0);
  return autoAttempts(events, ticket, "check").filter((e) => Date.parse(e.at) > moved);
}

/**
 * A finished contact whose PR checks fail gets at most two automatic Check PR requests per base. The second
 * waits until the mission reported the first result (or it went silent for 45 minutes) and CI reran; a
 * mission that reported it cannot fix the checks is left for the operator until the base moves.
 */
export function autoCheckDue(events: Event[], c: ContactView, now: number): boolean {
  const attempts = autoChecksSinceBase(events, c.ticket);
  if (attempts.length >= MAX_AUTO_CHECKS) return false;
  const last = attempts.at(-1);
  if (!last) return true;
  const at = Date.parse(last.at);
  if (now - at < CHECK_SPACING_MS) return false;
  if (c.check && Date.parse(c.check.at) > at) return c.check.state !== "checks";
  return now - at >= CHECK_STALE_MS;
}

export interface AutoDeps {
  home: string;
  now(): Date;
  settings(): Promise<Settings>;
  extras(opId: string): Required<ProjectionExtras>;
  /** The same runner operator clicks use; auto requests carry `by: "auto"`. */
  run(req: ActionRequest): Promise<void>;
  integrationReady(operation: Operation, branch: string): Promise<void>;
  /** Internal failures (store reads, settings); action failures already pause via `auto` events. */
  warn(message: string): void;
  /** Refresh watcher load after opening a pane, so the next pass does not count against a stale cap. */
  settle?(opId: string): Promise<void>;
}

/**
 * Auto mode: after each watcher pass, land finished missions and launch the next ready contact.
 * Launches take up to 90 s, so the caller fires this without awaiting; `busy` keeps one launch per
 * operation at a time. A failed action backs that contact off instead of switching Auto off.
 */
export function createAuto(deps: AutoDeps): { pass(): Promise<void>; landingWait(opId: string): string | null } {
  const busy = new Set<string>();
  const landingWaits = new Map<string, { reason: string; retryAt: number }>();
  // A finished contact whose work is not in the base yet (Mark done refused): leave it, try again much later.
  const unmerged = new Map<string, number>();

  async function pause(opId: string, reason: string): Promise<void> {
    landingWaits.delete(opId);
    try {
      await mutateOperation(deps.home, opId, (op) => (op.auto ? { ...op, auto: { ...op.auto, enabled: false } } : op));
      await appendEvent(deps.home, opId, { v: 1, at: deps.now().toISOString(), kind: "auto", enabled: false, reason, by: "board" });
    } catch (error) {
      deps.warn(`auto pause ${opId}: ${messageOf(error)}`);
    }
  }

  async function runOp(opId: string): Promise<void> {
    const projection = await loadProjection(deps.home, opId, await deps.settings(), deps.now().getTime(), deps.extras(opId));
    const auto = projection.operation.auto;
    if (!auto?.enabled || !auto.land) landingWaits.delete(opId);
    if (!auto?.enabled) return;

    if (projection.contacts.length > 0 && projection.contacts.every((c) => c.state === "landed")) {
      await pause(opId, "every contact landed");
      return;
    }
    const events = await readEvents(deps.home, opId);
    const now = deps.now().getTime();
    const allowed = (ticket: string, op: string) => autoRetryAllowed(events, ticket, op, now);
    // Slots Recovery is about to reuse for crashed missions; new work must not take them.
    const reserved = relaunchesPending(projection, deps.extras(opId), events, now).length;
    /** The runner already recorded the failure as an `operator` event; the backoff reads it from there. */
    const attempt = async (req: Omit<ActionRequest, "op" | "by">): Promise<boolean> => {
      try {
        await deps.run({ ...req, op: opId, by: "auto" });
        if (req.action === "launch" || req.action === "decide-agent") await deps.settle?.(opId);
        return true;
      } catch (error) {
        deps.warn(`auto ${opId} ${req.action} ${req.contact}: ${messageOf(error)}`);
        return false;
      }
    };

    if (auto.plans && !auto.capacityWait) {
      const statuses = deps.extras(opId).statuses;
      const target = projection.contacts.find((c) => {
        const status = statuses[c.ticket];
        if (status?.hold !== "plan-approval" || !status.ctl || !status.actions.includes("plan-approve")) return false;
        if (deps.extras(opId).owners[c.ticket] !== "live" || !allowed(c.ticket, "plan-approve")) return false;
        const revision = status.plan?.revision;
        return !events.some((e) => e.kind === "operator" && e.op === "plan-approve" && e.contact === c.ticket && e.ok &&
          e.args?.revision === revision);
      });
      if (target) {
        await attempt({ contact: target.ticket, action: "plan-approve", args: { revision: statuses[target.ticket]?.plan?.revision } });
        return;
      }
    }
    if (auto.reviews && !auto.capacityWait) {
      const { statuses, owners } = deps.extras(opId);
      // `mode` is advertised only outside native plan mode; once per contact, so an operator who sets Auto back wins.
      const target = projection.contacts.find((c) => {
        const status = statuses[c.ticket];
        return status?.mode === "auto" && !status.complete && status.ctl !== null && status.actions.includes("mode") &&
          owners[c.ticket] === "live" && !reviewsRequested(events, c.ticket) && allowed(c.ticket, "mode");
      });
      if (target) {
        await attempt({ contact: target.ticket, action: "mode", args: { mode: "force" } });
        return;
      }
    }
    if (auto.repairs && !auto.capacityWait) {
      const target = projection.contacts.find(contact => {
        const status = deps.extras(opId).statuses[contact.ticket];
        return status?.problem?.source === "repair-budget" && status.problem.kind === "error" &&
          status.verify === "passed" && status.mode !== "pause" && contact.owner === "live" &&
          canDo(contact, "review") &&
          !events.some(event => event.kind === "operator" && event.contact === contact.ticket &&
            event.op === "review" && event.by === "auto" && event.args?.repairBudgetOnly === true);
      });
      if (target) {
        await attempt({ contact: target.ticket, action: "review", args: { repairBudgetOnly: true } });
        return;
      }
    }

    if (auto.land && !auto.capacityWait) {
      // `land-anyway` is offered exactly when failing checks block Land and ignoreChecks is off.
      const target = projection.contacts.find((c) => c.state === "complete" && c.owner === "live" &&
        actionOf(c, "land-anyway") !== undefined && canDo(c, "check") &&
        allowed(c.ticket, "check") && autoCheckDue(events, c, now));
      if (target) await attempt({ contact: target.ticket, action: "check", args: {} });
    }

    if (auto.land) {
      const target = projection.contacts.find((c) => {
        if (c.state !== "complete") return false;
        if ((unmerged.get(`${opId}/${c.ticket}`) ?? 0) > deps.now().getTime()) return false;
        if (canDo(c, "land")) return allowed(c.ticket, "land");
        // A conflict contact is its target's resolution: the target's Land carries it. Marking it done first
        // would drop the resolution and reopen the conflict, so auto only finishes one whose target has landed.
        if (c.kind === "conflict" && contactOf(projection, c.conflictOf ?? "")?.state !== "landed") return false;
        return (c.kind === "audit" || c.kind === "conflict") && canDo(c, "done") && allowed(c.ticket, "done");
      });
      if (!target) landingWaits.delete(opId);
      if (target) {
        const landable = canDo(target, "land");
        const wait = landingWaits.get(opId);
        if (!landable || !wait || deps.now().getTime() >= wait.retryAt) {
          try {
            if (landable) {
              const operation = await readOperation(deps.home, opId);
              const branch = resolutionFor(operation, projection, target.ticket)?.lane?.branch ?? contactOf(operation, target.ticket)?.lane?.branch;
              if (branch) await deps.integrationReady(operation, branch);
            }
            landingWaits.delete(opId);
            await deps.run({ op: opId, contact: target.ticket, action: landable ? "land" : "done", args: {}, by: "auto" });
          } catch (error) {
            const code = error instanceof PortError || error instanceof ActionError ? error.code : null;
            if (code === "integration-dirty" || code === "integration-wrong-branch") {
              // Readiness can change between preflight and merge. Never retry a blocked merge each poll.
              landingWaits.set(opId, { reason: `${target.ticket}: ${messageOf(error)}`, retryAt: deps.now().getTime() + 30_000 });
            } else if (code === "not-merged") {
              unmerged.set(`${opId}/${target.ticket}`, deps.now().getTime() + 10 * 60_000);
            } else if (code === "branch-updated" || code === "pr-opened") {
              // GitHub needs a moment to register the new head's checks, or the probe to see the new PR.
              unmerged.set(`${opId}/${target.ticket}`, deps.now().getTime() + 3 * 60_000);
            } else if (code !== "conflict-opened") {
              const reason = `${target.ticket}: ${messageOf(error)}`;
              deps.warn(`auto ${opId} land ${reason}`);
              // A preflight failure never reached the runner, so it leaves no event to back off on.
              if (!(error instanceof ActionError)) landingWaits.set(opId, { reason, retryAt: deps.now().getTime() + BACKOFF_MS[0]! });
            }
          }
        }
      }
    }

    if (auto.decide) {
      // Each ready decision either lands on its recommended option for free or gets an agent pane,
      // which counts as a live omp: stop opening panes once maxLive or the cap is reached.
      let live = projection.header.live;
      let open = projection.header.open;
      for (const target of projection.contacts) {
        if (target.state !== "decision" || target.decision !== null || target.decisionPane) continue;
        if (!target.blockedBy.every((b) => b.landed)) continue;
        if (target.recommended !== undefined) {
          try {
            const at = deps.now().toISOString();
            await appendEvent(deps.home, opId, {
              v: 1, at, kind: "decided", contact: target.ticket, choice: target.recommended, by: "recommended",
            });
            await appendEvent(deps.home, opId, { v: 1, at, kind: "landed", contact: target.ticket, via: "manual" });
          } catch (error) {
            await pause(opId, messageOf(error));
            return;
          }
        } else if (!auto.capacityWait && live + reserved < auto.maxLive && open + reserved < projection.header.cap && allowed(target.ticket, "decide-agent")) {
          if (await attempt({ contact: target.ticket, action: "decide-agent", args: {} })) {
            live += 1;
            open += 1;
          }
        }
      }
    }

    if (auto.launch && !auto.capacityWait && projection.header.live + reserved < auto.maxLive && projection.header.open + reserved < projection.header.cap) {
      // Ready contacts launch in declaration order, biased toward the one that unblocks
      // the most unlanded work: long dependency chains cost more wall time than order.
      const unblocks = new Map<string, number>();
      for (const c of projection.contacts) {
        if (c.state === "landed") continue;
        for (const b of c.blockedBy) if (!b.landed) unblocks.set(b.ticket, (unblocks.get(b.ticket) ?? 0) + 1);
      }
      const next = projection.contacts.reduce<typeof projection.contacts[number] | undefined>((best, c) => {
        if (c.group !== "queue" || c.state !== "ready" || !canDo(c, "launch")) return best;
        if (!allowed(c.ticket, "launch")) return best;
        if (!best || (unblocks.get(c.ticket) ?? 0) > (unblocks.get(best.ticket) ?? 0)) return c;
        return best;
      }, undefined);
      if (next) await attempt({ contact: next.ticket, action: "launch", args: {} });
    }
  }

  return {
    landingWait: (opId) => landingWaits.get(opId)?.reason ?? null,
    async pass(): Promise<void> {
      const rows = await listOperations(deps.home);
      const ids = new Set(rows.map(row => row.id));
      for (const id of landingWaits.keys()) if (!ids.has(id)) landingWaits.delete(id);
      for (const row of rows) {
        if (busy.has(row.id)) continue;
        busy.add(row.id);
        try {
          await runOp(row.id);
        } catch (error) {
          deps.warn(`auto ${row.id}: ${messageOf(error)}`);
        } finally {
          busy.delete(row.id);
        }
      }
    },
  };
}
