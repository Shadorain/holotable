import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Contact, LaunchStep, Operation, Settings, TerminalRef } from "../core/types.ts";
import { PortError, type FleetPort, type Ports } from "../ports.ts";
import { loadProjection, type ProjectionExtras } from "../snapshot.ts";
import { appendEvent, readEvents } from "../store/events.ts";
import { ensureLaunchOverlay } from "../store/launch.ts";
import { mutateOperation, readOperation } from "../store/operations.ts";
import { ActionError } from "./errors.ts";
import { hasRecentUncontrolledStatus, memoryLaunchRefusal } from "../core/policy.ts";

export interface LauncherDeps {
  home: string;
  now(): Date;
  settings(): Promise<Settings>;
  portsFor(operation: Operation, settings: Settings): Ports;
  extras(opId: string): ProjectionExtras;
  sleep(ms: number): Promise<void>;
  /** 6 hex chars naming a conflict worktree. */
  token(): string;
  /** How long to wait for the child's control socket after its terminal opens. */
  socketWaitMs?: number;
  /** Shared action-runner keys (op/ticket → action); lets launches and End see each other. */
  inFlight?: Map<string, string>;
  availableMemory?(): number | null;
}

const POLL_MS = 1_000;
const DEFAULT_SOCKET_WAIT_MS = 90_000;

export function slug(ticket: string): string {
  return ticket.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

async function recordedConflictPaths(deps: LauncherDeps, opId: string, original: string): Promise<string[]> {
  const events = await readEvents(deps.home, opId);
  for (const e of [...events].reverse())
    if (e.kind === "land-attempt" && e.contact === original && e.outcome === "conflict") return e.paths ?? [];
  return [];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A step that stopped a launch or relaunch: record why, then fail the action. */
async function failLaunch(deps: LauncherDeps, opId: string, ticket: string, step: LaunchStep, error: unknown): Promise<never> {
  await appendEvent(deps.home, opId, { v: 1, at: deps.now().toISOString(), kind: "launch-failed", contact: ticket, step, error: message(error) });
  throw new ActionError(502, "launch-failed", `${step}: ${message(error)}`);
}

/** Poll the child's status file until its control socket pings; `socket` failure after the budget. */
async function waitForSocket(deps: LauncherDeps, opId: string, ticket: string, worktree: string, fleet: FleetPort): Promise<void> {
  const budget = deps.socketWaitMs ?? DEFAULT_SOCKET_WAIT_MS;
  // A poll's read/ping can take seconds, so a deadline bounds real elapsed time; `waited` still
  // caps the number of polls so a stalled clock cannot spin forever.
  const deadline = deps.now().getTime() + budget;
  for (let waited = 0; waited <= budget && deps.now().getTime() <= deadline; waited += POLL_MS) {
    try {
      const status = await fleet.read({ worktree });
      if (status?.ctl && (await fleet.ping(status))) {
        await appendEvent(deps.home, opId, { v: 1, at: deps.now().toISOString(), kind: "socket-up", contact: ticket, generation: status.ctl.generation });
        return;
      }
    } catch {
      // The child is still starting; the next poll retries and the timeout reports a persistent failure.
    }
    if (waited + POLL_MS <= budget) await deps.sleep(POLL_MS);
  }
  await failLaunch(deps, opId, ticket, "socket", `no control socket after ${Math.round(budget / 1000)} s`);
}

/**
 * Launch a queued contact: worktree, terminal, then wait for the child's control socket. Each step is
 * skipped when its result is already on `contact.lane`, so launching again resumes where a failure stopped.
 * Nothing here approves or controls the mission: the child opens a pending plan and waits for the operator.
 */
export async function launchContact(
  deps: LauncherDeps,
  opId: string,
  ticket: string,
  extra: { conflictPaths?: string[]; model?: string | null } = {},
): Promise<void> {
  const settings = await deps.settings();
  const projection = await loadProjection(deps.home, opId, settings, deps.now().getTime(), deps.extras(opId));
  const offered = projection.contacts.find((c) => c.ticket === ticket)?.actions.find((a) => a.id === "launch");
  if (!offered) throw new ActionError(409, "refused", `${ticket} cannot be launched in its current state`);
  if (!offered.enabled) throw new ActionError(409, "refused", offered.reason ?? "launch refused");
  // Watcher load misses in-flight launches; count them so overlapping launches can't pass cap together.
  const inflightLaunches = [...(deps.inFlight?.values() ?? [])].filter((a) => a === "launch" || a === "relaunch").length - (deps.inFlight?.get(`${opId}/${ticket}`) === "launch" ? 1 : 0);
  if (inflightLaunches > 0 && projection.header.open + inflightLaunches >= projection.header.cap)
    throw new ActionError(409, "refused", `cap ${projection.header.open + inflightLaunches}/${projection.header.cap} omp`);

  const operation = await readOperation(deps.home, opId);
  const contact = operation.contacts.find((c) => c.ticket === ticket) as Contact;
  if (!contact.lane?.terminal) {
    const memory = memoryLaunchRefusal(deps.availableMemory?.() ?? null, Math.max(0, inflightLaunches));
    if (memory) throw new ActionError(409, "memory-pressure", memory);
  }
  const ports = deps.portsFor(operation, settings);
  const at = () => deps.now().toISOString();
  // A conflict mission launched from its card (after a refused launch) still needs the paths it may edit.
  const conflictPaths =
    extra.conflictPaths ?? (contact.kind === "conflict" && contact.conflictOf ? await recordedConflictPaths(deps, opId, contact.conflictOf) : []);

  const fail = (step: LaunchStep, error: unknown): Promise<never> => failLaunch(deps, opId, ticket, step, error);
  const setLane = (lane: NonNullable<Contact["lane"]>) =>
    mutateOperation(deps.home, opId, (op) => ({
      ...op,
      contacts: op.contacts.map((c) => (c.ticket === ticket ? { ...c, lane } : c)),
    }));

  try {
    await ports.frontend.ensureRepo(operation.repo);
  } catch (error) {
    return fail("repo", error);
  }

  let lane = contact.lane;
  let workspaceTerminal: TerminalRef | null = null;
  let workspaceStartup: ReturnType<FleetPort["launch"]> | undefined;
  const explicitModelOverride = extra.model !== undefined ? extra.model : lane?.model;
  const selectedModel = explicitModelOverride !== undefined
    ? explicitModelOverride
    : (settings.ai.mission ?? settings.ai.model);
  const startup = async (worktree: string) => ports.fleet.launch({
    operation,
    contact,
    worktree,
    overlay: await ensureLaunchOverlay(deps.home),
    ...(conflictPaths.length ? { conflictPaths } : {}),
    model: selectedModel,
    thinking: settings.ai.thinking,
  });
  if (!lane) {
    try {
      const name = contact.kind === "conflict" ? `conflict-${deps.token()}` : slug(ticket);
      const input = {
        repo: operation.repo,
        name,
        base: operation.base,
        ticket: operation.tracker === "linear" && contact.kind !== "conflict" ? ticket : null,
        delivery: operation.delivery,
      };
      let created;
      if (ports.frontend.createWorkspaceWithTerminal) {
        workspaceStartup = await startup(".");
        const opened = await ports.frontend.createWorkspaceWithTerminal({ ...input, startup: workspaceStartup });
        created = opened;
        workspaceTerminal = opened.terminal;
      } else {
        created = await ports.frontend.createWorkspace(input);
      }
      lane = { worktree: created.worktree, branch: created.branch, frontend: operation.frontend, terminal: null };
      await setLane(lane);
    } catch (error) {
      if (workspaceTerminal && lane)
        await ports.frontend.close(workspaceTerminal, lane.worktree).catch(() => undefined);
      return fail("workspace", error);
    }
  }

  let terminal = lane.terminal;
  if (!terminal) {
    try {
      const { argv, env } = workspaceStartup ?? await startup(lane.worktree);
      terminal = workspaceTerminal ?? await ports.frontend.openTerminal({
        worktree: lane.worktree,
        title: `${ticket} ${operation.name}`,
        argv,
        env,
      });
      try {
        lane = {
          ...lane,
          terminal,
          ...(explicitModelOverride !== undefined ? { model: explicitModelOverride } : {}),
        };
        await setLane(lane);
        await appendEvent(deps.home, opId, {
          v: 1,
          at: at(),
          kind: "launched",
          contact: ticket,
          worktree: lane.worktree,
          frontend: operation.frontend,
          terminal,
        });
      } catch (error) {
        // The pane is running but the lane never recorded it; close it so a retry cannot leave two.
        await ports.frontend.close(terminal, lane.worktree).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      return fail("terminal", error);
    }
  }

  await waitForSocket(deps, opId, ticket, lane.worktree, ports.fleet);
}

/**
 * Bring a dead lane back: close the recorded terminal (a vanished pane is already gone), open a
 * fresh child in the same worktree, then wait for its control socket. The worktree still holds a
 * saved mission, so the child re-attaches it under `resumeHold` — `OMP_MISSION_AUTOSTART` is ignored
 * on attach — and sits at hold "resume" until someone (you or recovery) continues it.
 */
export async function relaunchContact(deps: LauncherDeps, opId: string, ticket: string, recovering = false): Promise<void> {
  const settings = await deps.settings();
  // Reserve a cap slot: watcher load misses relaunches still opening their pane.
  const load = deps.extras(opId).load;
  const inflightLaunches = [...(deps.inFlight?.values() ?? [])].filter((a) => a === "launch" || a === "relaunch").length - (deps.inFlight?.get(`${opId}/${ticket}`) === "relaunch" ? 1 : 0);
  if (load && load.open + inflightLaunches >= settings.cap)
    throw new ActionError(409, "refused", `cap ${load.open + inflightLaunches}/${settings.cap} omp`);
  const memory = memoryLaunchRefusal(deps.availableMemory?.() ?? null, Math.max(0, inflightLaunches));
  if (memory) throw new ActionError(409, "memory-pressure", memory);
  const operation = await readOperation(deps.home, opId);
  if (recovering && !operation.recover)
    throw new ActionError(409, "refused", "Recovery is disabled for this operation");
  const contact = operation.contacts.find((c) => c.ticket === ticket) as Contact;
  const lane = contact.lane as NonNullable<Contact["lane"]>;
  const terminal = lane.terminal as TerminalRef;
  const ports = deps.portsFor(operation, settings);
  const at = () => deps.now().toISOString();

  // Recovery may have queued this before a manually reopened session acquired the socket.
  const saved = await ports.fleet.read({ worktree: lane.worktree });
  if (saved?.ctl && await ports.fleet.ping(saved))
    throw new ActionError(409, "refused", "Mission already has a live control socket; focus or continue it instead");
  if (hasRecentUncontrolledStatus(saved, deps.now().getTime()))
    throw new ActionError(409, "refused", "Mission is publishing status without board control; use its existing pane");

  const listed = await ports.frontend.listTerminals();
  if (recovering) {
    // A quiet or manually resumed mission can outlive both its socket and recorded incarnation.
    if (listed === null)
      throw new ActionError(409, "refused", "Automatic relaunch requires terminal inventory; inspect the existing pane");
    const worktree = await realpath(lane.worktree).catch(() => resolve(lane.worktree));
    for (const row of listed) {
      const path = await realpath(row.worktree).catch(() => resolve(row.worktree));
      if (path === worktree || row.handle === terminal.handle)
        throw new ActionError(409, "refused", "Automatic relaunch requires an empty workspace; use the existing pane or inspect it before manual Relaunch");
    }
  }
  if (listed === null || listed.some((row) => row.handle === terminal.handle && row.incarnationId === terminal.incarnationId)) {
    try {
      await ports.frontend.close(terminal, lane.worktree);
    } catch (error) {
      if (!(error instanceof PortError && error.code === "terminal-missing")) throw error;
    }
  }
  // A saved mission past its plan resumes outside plan mode, where `continue` is allowed; one still planning reopens in it.
  const overlay = await ensureLaunchOverlay(deps.home, saved && saved.phase !== "plan" ? "resume" : "plan");
  const selectedModel = lane.model !== undefined
    ? lane.model
    : (settings.ai.mission ?? settings.ai.model);
  const { argv, env } = ports.fleet.launch({
    operation,
    contact,
    worktree: lane.worktree,
    overlay,
    model: selectedModel,
    thinking: settings.ai.thinking,
  });
  const opened = await ports.frontend.openTerminal({
    worktree: lane.worktree,
    title: `${ticket} ${operation.name}`,
    argv,
    env,
  });
  // A pane may not come up even without a thrown error; only swap the recorded terminal for a real one.
  if (opened.handle === terminal.handle && opened.incarnationId === terminal.incarnationId) {
    await ports.frontend.close(opened, lane.worktree).catch(() => undefined);
    throw new ActionError(502, "relaunch", "frontend could not open a fresh terminal");
  }
  try {
    await mutateOperation(deps.home, opId, (op) => ({
      ...op,
      contacts: op.contacts.map((c) => (c.ticket === ticket ? { ...c, lane: { ...c.lane!, terminal: opened } } : c)),
    }));
    await appendEvent(deps.home, opId, {
      v: 1,
      at: at(),
      kind: "launched",
      contact: ticket,
      worktree: lane.worktree,
      frontend: operation.frontend,
      terminal: opened,
    });
  } catch (error) {
    // The new pane is running but unrecorded: a retried relaunch would open a second one.
    await ports.frontend.close(opened, lane.worktree).catch(() => undefined);
    throw error;
  }
  await waitForSocket(deps, opId, ticket, lane.worktree, ports.fleet);
}
