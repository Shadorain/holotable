import type { Contact, Operation } from "../core/types.ts";
import { PortError, type Run } from "../ports.ts";
import { loadProjection } from "../snapshot.ts";
import { appendEvent } from "../store/events.ts";
import { mutateOperation, readOperation } from "../store/operations.ts";
import { ActionError } from "./errors.ts";
import { cleanupAfterLand } from "./cleanup.ts";
import { launchContact, type LauncherDeps } from "./launcher.ts";

export interface LanderDeps extends LauncherDeps {
  run: Run;
}

/** Highest `-conflict-<n>` contact opened for `ticket`, if any. */
function newestConflict(operation: Operation, ticket: string): Contact | null {
  const rank = (c: Contact) => Number(c.ticket.match(/-conflict-(\d+)$/i)?.[1] ?? 0);
  return operation.contacts.filter((c) => c.conflictOf === ticket).sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

/**
 * Land a completed contact on the integration worktree (an operator click). A clean merge records `landed`.
 * A conflict leaves the integration checkout clean and opens one new local-graph conflict mission in a worktree
 * that already holds the markers; the original contact stays and Land waits for that mission.
 */
export async function landContact(deps: LanderDeps, opId: string, ticket: string): Promise<void> {
  const settings = await deps.settings();
  const projection = await loadProjection(deps.home, opId, settings, deps.now().getTime(), deps.extras(opId));
  const offered = projection.contacts.find((c) => c.ticket === ticket)?.actions.find((a) => a.id === "land");
  if (!offered?.enabled) throw new ActionError(409, "refused", offered?.reason ?? `${ticket} cannot be landed in its current state`);

  const operation = await readOperation(deps.home, opId);
  const contact = operation.contacts.find((c) => c.ticket === ticket) as Contact;
  const ports = deps.portsFor(operation, settings);
  const resolution = newestConflict(operation, ticket);
  const sourceBranch = resolution?.lane?.branch ?? contact.lane?.branch;
  if (!sourceBranch) throw new ActionError(409, "refused", `${ticket} has no branch recorded to land`);
  const lane = contact.lane;
  if (!lane) throw new ActionError(409, "refused", `${ticket} has no lane`);
  const status = await ports.fleet.read({ worktree: lane.worktree });
  if (!status) throw new ActionError(409, "owner-offline", `No mission status for ${ticket}`);
  const at = () => deps.now().toISOString();

  const result = await ports.delivery.land({ operation, contact, sourceBranch, status });
  if (result.outcome === "landed") {
    await appendEvent(deps.home, opId, { v: 1, at: at(), kind: "land-attempt", contact: ticket, outcome: "clean" });
    await appendEvent(deps.home, opId, { v: 1, at: at(), kind: "landed", contact: ticket, via: result.via });
    if (resolution && resolution.lane?.branch === sourceBranch)
      await appendEvent(deps.home, opId, { v: 1, at: at(), kind: "landed", contact: resolution.ticket, via: result.via });
    await cleanupAfterLand(deps, opId, ticket);
    return;
  }

  await appendEvent(deps.home, opId, { v: 1, at: at(), kind: "land-attempt", contact: ticket, outcome: "conflict", paths: result.paths });
  const hex = deps.token();
  const pin = `holotable/conflict-base-${hex}`;
  // Pin the delivered commit to a branch name: every frontend accepts a branch as a base, not all accept a sha.
  const pinned = await deps.run("git", ["branch", pin, result.deliveredSha], operation.repo);
  if (pinned.code !== 0) throw new PortError("git", `Cannot pin ${result.deliveredSha}: ${pinned.stderr.trim()}`);
  let workspace: { worktree: string; branch: string | null };
  try {
    workspace = await ports.frontend.createWorkspace({ repo: operation.repo, name: `conflict-${hex}`, base: pin, ticket: null });
  } finally {
    await deps.run("git", ["branch", "-D", pin], operation.repo);
  }
  const n = operation.contacts.filter((c) => c.conflictOf === ticket).length + 1;
  const conflictTicket = `${ticket}-conflict-${n}`;
  const created: Contact = {
    ticket: conflictTicket,
    title: `Resolve conflicts for ${ticket}`,
    zone: contact.zone,
    kind: "conflict",
    blockedBy: [],
    conflictOf: ticket,
    lane: { worktree: workspace.worktree, branch: workspace.branch, frontend: operation.frontend, terminal: null },
  };
  try {
    // Exit 1 is the point: the merge stops with markers in the files the mission will edit.
    await deps.run("git", ["merge", "--no-commit", "--no-ff", result.baseSha], workspace.worktree);
    const marked = await deps.run("git", ["diff", "--name-only", "--diff-filter=U"], workspace.worktree);
    if (marked.stdout.trim() === "")
      throw new PortError("git", "The conflict worktree has no conflict markers; nothing for a conflict mission to resolve");
    await mutateOperation(deps.home, opId, (op) => ({ ...op, contacts: [...op.contacts, created] }));
  } catch (error) {
    // The worktree (and its holotable/conflict-* branch) is recorded nowhere yet; tear it down best-effort.
    await deps.run("git", ["merge", "--abort"], workspace.worktree).catch(() => {});
    await ports.frontend.removeWorkspace({ repo: operation.repo, worktree: workspace.worktree }).catch(() => {});
    if (workspace.branch) await deps.run("git", ["branch", "-D", workspace.branch], operation.repo).catch(() => {});
    throw error;
  }
  await appendEvent(deps.home, opId, { v: 1, at: at(), kind: "queued", contact: created.ticket, source: "conflict" });
  await appendEvent(deps.home, opId, { v: 1, at: at(), kind: "conflict-opened", contact: ticket, conflictContact: created.ticket });
  try {
    await launchContact(deps, opId, created.ticket, { conflictPaths: result.paths });
  } catch (error) {
    // The conflict is real and recorded; only the launch of its mission failed, and Launch on its card retries.
    const reason = error instanceof Error ? error.message : String(error);
    throw new ActionError(409, "conflict-opened", `Land hit conflicts in ${result.paths.length} file(s). Conflict mission ${created.ticket} is open but not launched: ${reason}`);
  }
}
