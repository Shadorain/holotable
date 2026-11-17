import type { Contact, ContactStatus, Operation, Settings } from "../core/types.ts";
import { messageOf } from "../core/errors.ts";
import { describeStatus, worktreeStatus } from "./worktree-status.ts";
import { appendEvent, readFolded } from "../store/events.ts";
import { readOperation } from "../store/operations.ts";
import type { Ports, Run } from "../ports.ts";
import { PortError } from "../ports.ts";

export interface WinddownDeps {
  home: string;
  now(): Date;
  settings(): Promise<Settings>;
  portsFor(operation: Operation, settings: Settings): Ports;
  /** Board-local Run. Remote closer retrieval fails closed without it. */
  localRun?: Run;
  /** Shared action-runner keys (op/ticket → action); End refuses while any op action runs. */
  inFlight?: Map<string, string>;
  captureMetrics?(operation:Operation,contact:Contact,status?:ContactStatus|null):Promise<void>;
}

/**
 * End-of-operation teardown, shared by abort and close. For every contact (conflict missions
 * included): close a recorded terminal (`terminal-missing` counts as closed → `reaped`), then
 * remove a frontend-owned worktree that has no `removed` event yet. `abort` force-removes even
 * dirty worktrees (the operator confirmed the dirty list first); `close` skips a worktree whose
 * `git status --porcelain` is dirty or unreadable so uncommitted work survives, and records the
 * skip. A failure never stops the wind-down; it becomes an `operator {ok: false}` event.
 */
export async function windDown(deps: WinddownDeps, opId: string, op: "abort" | "close"): Promise<void> {
  const operation = await readOperation(deps.home, opId);
  const { derived } = await readFolded(deps.home, opId);
  const at = () => deps.now().toISOString();
  const fail = async (ticket: string, error: unknown) =>
    appendEvent(deps.home, opId, {
      v: 1,
      at: at(),
      kind: "operator",
      contact: ticket,
      op,
      ok: false,
      error: `${ticket}: ${messageOf(error)}`,
    });

  // Ports resolve on first use only: closing an all-none operation must not build adapters.
  let ports: Ports | null = null;
  const resolve = async () => {
    ports ??= deps.portsFor(operation, await deps.settings());
    return ports;
  };
  const frontend = async () => (await resolve()).frontend;
  // Host-routed run: placed operations run git on their execution host via the relay.
  const runOnHost = async () => (await resolve()).run;

  for (const contact of operation.contacts) {
    const lane = contact.lane;
    if (!lane) continue;
    const d = derived.contacts[contact.ticket];

    if (lane.terminal && !d?.reaped) {
      await deps.captureMetrics?.(operation,contact);
      try {
        await (await frontend()).close(lane.terminal, lane.worktree);
        await appendEvent(deps.home, opId, { v: 1, at: at(), kind: "reaped", contact: contact.ticket });
      } catch (error) {
        if (error instanceof PortError && error.code === "terminal-missing") {
          await appendEvent(deps.home, opId, { v: 1, at: at(), kind: "reaped", contact: contact.ticket });
        } else await fail(contact.ticket, error);
      }
    }

    if (lane.frontend !== "external" && !d?.removed) {
      try {
        const status = await worktreeStatus(await runOnHost(), lane.worktree);
        if (status.state === "gone") {
          // The checkout is already gone; the registry may still know it, so try removal anyway.
        } else if (status.state === "unknown") {
          await fail(contact.ticket, `worktree status unreadable (${status.detail ?? "git status failed"}); keeping ${lane.worktree}`);
          continue;
        } else if (op === "close" && status.state === "dirty") {
          // A close keeps uncommitted work — ignored files count, they are still user content.
          await fail(contact.ticket, `worktree is dirty: ${describeStatus(status)}`);
          continue;
        }
        // abort proceeds for "dirty"; only an unreadable status blocks deletion.
        await (await frontend()).removeWorkspace({
          repo: operation.repo,
          worktree: lane.worktree,
          worktreeId: lane.worktreeId,
          ...(op === "abort" ? { force: true } : {}),
        });
        await appendEvent(deps.home, opId, {
          v: 1,
          at: at(),
          kind: "removed",
          contact: contact.ticket,
          worktree: lane.worktree,
        });
      } catch (error) {
        await fail(contact.ticket, error);
      }
    }
  }
}
