import { readEvents } from "../store/events.ts";
import type { ActionRequest } from "../board.ts";
import type { Operation, Settings } from "../core/types.ts";
import { loadProjection, type ProjectionExtras } from "../snapshot.ts";
import { appendEvent } from "../store/events.ts";
import { listOperations, mutateOperation, readOperation } from "../store/operations.ts";
import { ActionError } from "./errors.ts";
import { PortError } from "../ports.ts";

export interface AutoDeps {
  home: string;
  now(): Date;
  settings(): Promise<Settings>;
  extras(opId: string): Required<ProjectionExtras>;
  /** The same runner operator clicks use; auto requests carry `by: "auto"`. */
  run(req: ActionRequest): Promise<void>;
  integrationReady(operation: Operation): Promise<void>;
  /** Internal failures (store reads, settings); action failures already pause via `auto` events. */
  warn(message: string): void;
}

/**
 * Auto mode: after each watcher pass, land finished missions and launch the next ready contact.
 * Launches take up to 90 s, so the caller fires this without awaiting; `busy` keeps one launch per
 * operation at a time. Decision contacts and plan approval are never touched: they wait for you.
 */
export function createAuto(deps: AutoDeps): { pass(): Promise<void>; landingWait(opId: string): string | null } {
  const busy = new Set<string>();
  const landingWaits = new Map<string, { reason: string; retryAt: number }>();

  async function pause(opId: string, reason: string): Promise<void> {
    landingWaits.delete(opId);
    try {
      await mutateOperation(deps.home, opId, (op) => (op.auto ? { ...op, auto: { ...op.auto, enabled: false } } : op));
      await appendEvent(deps.home, opId, { v: 1, at: deps.now().toISOString(), kind: "auto", enabled: false, reason, by: "board" });
    } catch (error) {
      deps.warn(`auto pause ${opId}: ${error instanceof Error ? error.message : String(error)}`);
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

    if (auto.plans) {
      const target = projection.contacts.find((c) => {
        const status = deps.extras(opId).statuses[c.ticket];
        if (status?.hold !== "plan-approval") return false;
        if (!status.ctl) return false;
        if (!status.actions.includes("plan-approve")) return false;
        const ownerLive = deps.extras(opId).owners[c.ticket] === "live";
        if (!ownerLive) return false;
        return true;
      });
      if (target) {
        const events = await readEvents(deps.home, opId);
        const status = deps.extras(opId).statuses[target.ticket];
        if (!status) return;
        const revision = status.plan?.revision;
        const attempted = events.some(
          (e) => e.kind === "operator" && e.op === "plan-approve" && e.contact === target.ticket && (e as Record<string, any>).args?.revision === revision
        );
        if (!attempted) {
          try {
            await deps.run({ op: opId, contact: target.ticket, action: "plan-approve", args: { revision }, by: "auto" });
          } catch (error) {
            await pause(opId, error instanceof Error ? error.message : String(error));
          }
          return;
        }
      }
    }

    if (auto.land) {
      const target = projection.contacts.find((c) => {
        if (c.state !== "complete") return false;
        if (c.actions.some((a) => a.id === "land" && a.enabled)) return true;
        return (c.kind === "audit" || c.kind === "conflict") && c.actions.some((a) => a.id === "done" && a.enabled);
      });
      if (!target) landingWaits.delete(opId);
      if (target) {
        const landable = target.actions.some((a) => a.id === "land" && a.enabled);
        const wait = landingWaits.get(opId);
        if (!landable || !wait || deps.now().getTime() >= wait.retryAt) {
          try {
            if (landable) await deps.integrationReady(await readOperation(deps.home, opId));
            landingWaits.delete(opId);
            await deps.run({ op: opId, contact: target.ticket, action: landable ? "land" : "done", args: {}, by: "auto" });
          } catch (error) {
            if ((error instanceof PortError || error instanceof ActionError) &&
                (error.code === "integration-dirty" || error.code === "integration-wrong-branch")) {
              // Readiness can change between preflight and merge. Never retry a blocked merge each poll.
              landingWaits.set(opId, { reason: `${target.ticket}: ${error.message}`, retryAt: deps.now().getTime() + 30_000 });
            } else if (!(error instanceof ActionError && error.code === "conflict-opened")) {
              await pause(opId, error instanceof Error ? error.message : String(error));
              return;
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
            await pause(opId, error instanceof Error ? error.message : String(error));
            return;
          }
        } else if (live < auto.maxLive && open < projection.header.cap) {
          try {
            await deps.run({ op: opId, contact: target.ticket, action: "decide-agent", args: {}, by: "auto" });
            live += 1;
            open += 1;
          } catch (error) {
            await pause(opId, error instanceof Error ? error.message : String(error));
            return;
          }
        }
      }
    }

    if (auto.launch && projection.header.live < auto.maxLive && projection.header.open < projection.header.cap) {
      const next = projection.contacts.find(
        (c) => c.group === "queue" && c.state === "ready" && c.actions.some((a) => a.id === "launch" && a.enabled),
      );
      if (next) {
        try {
          await deps.run({ op: opId, contact: next.ticket, action: "launch", args: {}, by: "auto" });
        } catch (error) {
          await pause(opId, error instanceof Error ? error.message : String(error));
        }
      }
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
          deps.warn(`auto ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          busy.delete(row.id);
        }
      }
    },
  };
}
