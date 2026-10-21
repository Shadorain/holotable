import { foldEvents } from "../core/fold.ts";
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
  const failed = (contact: string, error: unknown) =>
    appendEvent(deps.home, opId, {
      v: 1,
      at: at(),
      kind: "operator",
      contact,
      op: "cleanup",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });

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
          await failed(target.ticket, error);
        }
      }
    }

    // 2. Workspace removal
    if (lane.frontend !== "external") {
      try {
        const gitStatus = await deps.run("git", ["status", "--porcelain"], lane.worktree);
        if (gitStatus.code === 0 && gitStatus.stdout.trim() === "") {
          await ports.frontend.removeWorkspace({ repo: operation.repo, worktree: lane.worktree });
          await appendEvent(deps.home, opId, {
            v: 1,
            at: at(),
            kind: "removed",
            contact: target.ticket,
            worktree: lane.worktree,
          });
        } else {
          await failed(target.ticket, gitStatus.code !== 0 ? gitStatus.stderr.trim() || `git exit ${gitStatus.code}` : "worktree is dirty");
        }
      } catch (error) {
        await failed(target.ticket, error);
      }
    }
  }
}
