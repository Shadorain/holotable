import { foldEvents } from "../core/fold.ts";
import { messageOf } from "../core/errors.ts";
import { contactOf } from "../core/projection.ts";
import type { Operation, Settings } from "../core/types.ts";
import { PortError, type Ports, type Run } from "../ports.ts";
import { appendEvent, readEvents } from "../store/events.ts";
import { readOperation } from "../store/operations.ts";

export interface CleanupDeps {
  home: string;
  now: () => Date;
  settings: () => Promise<Settings>;
  portsFor: (operation: Operation, settings: Settings) => Ports;
  run: Run;
}

function cleanupFailed(deps: CleanupDeps, opId: string, contact: string, error: unknown) {
  return appendEvent(deps.home, opId, {
    v: 1,
    at: deps.now().toISOString(),
    kind: "operator",
    contact,
    op: "cleanup",
    ok: false,
    error: messageOf(error),
  });
}

async function removeWorkspace(deps: CleanupDeps, opId: string, operation: Operation, ports: Ports, contact: string, worktree: string) {
  await ports.frontend.removeWorkspace({ repo: operation.repo, worktree });
  await appendEvent(deps.home, opId, { v: 1, at: deps.now().toISOString(), kind: "removed", contact, worktree });
}

/**
 * After a contact lands (or is marked done with a lane), close terminals and remove clean worktrees
 * for the contact and every conflict contact of it, when settings.cleanup is true.
 * Cleanup failures append an operator failure event and never fail the land.
 */
export async function cleanupAfterLand(deps: CleanupDeps, opId: string, ticket: string): Promise<void> {
  const settings = await deps.settings();
  if (!settings.cleanup) return;

  const operation = await readOperation(deps.home, opId);
  const targets = operation.contacts.filter((c) => (c.ticket === ticket || c.conflictOf === ticket) && c.lane !== null);
  if (targets.length === 0) return;

  const derived = foldEvents(await readEvents(deps.home, opId));
  const ports = deps.portsFor(operation, settings);
  const at = () => deps.now().toISOString();

  for (const target of targets) {
    const lane = target.lane;
    if (!lane) continue;

    // 1. Terminal cleanup
    if (lane.terminal && !derived.contacts[target.ticket]?.reaped) {
      try {
        await ports.frontend.close(lane.terminal, lane.worktree);
        await appendEvent(deps.home, opId, { v: 1, at: at(), kind: "reaped", contact: target.ticket });
      } catch (error) {
        if (error instanceof PortError && error.code === "terminal-missing") {
          await appendEvent(deps.home, opId, { v: 1, at: at(), kind: "reaped", contact: target.ticket });
        } else {
          await cleanupFailed(deps, opId, target.ticket, error);
        }
      }
    }

    // 2. Workspace removal
    if (lane.frontend !== "external") {
      try {
        const gitStatus = await deps.run("git", ["status", "--porcelain"], lane.worktree);
        if (gitStatus.code === 0 && gitStatus.stdout.trim() === "") {
          await removeWorkspace(deps, opId, operation, ports, target.ticket, lane.worktree);
        } else {
          await cleanupFailed(deps, opId, target.ticket, gitStatus.code !== 0 ? gitStatus.stderr.trim() || `git exit ${gitStatus.code}` : "worktree is dirty");
        }
      } catch (error) {
        await cleanupFailed(deps, opId, target.ticket, error);
      }
    }
  }
}

/**
 * Reap abandons an unfinished conflict mission and no land will ever clean it up, so its worktree goes
 * now (settings.cleanup). Its uncommitted merge is removed with it: the next Land of the target replays
 * that merge in a fresh conflict worktree. The branch stays.
 */
export async function cleanupAbandonedConflict(deps: CleanupDeps, opId: string, ticket: string): Promise<void> {
  const settings = await deps.settings();
  if (!settings.cleanup) return;
  const operation = await readOperation(deps.home, opId);
  const lane = contactOf(operation, ticket)?.lane;
  if (!lane || lane.frontend === "external") return;
  try {
    await removeWorkspace(deps, opId, operation, deps.portsFor(operation, settings), ticket, lane.worktree);
  } catch (error) {
    await cleanupFailed(deps, opId, ticket, error);
  }
}
