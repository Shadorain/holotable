import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildReport } from "../core/report.ts";
import type { ClosedOutcome, Operation } from "../core/types.ts";
import { operationDir } from "../paths.ts";
import { writeReport } from "../store/archive.ts";
import { appendEvent, readEvents, readFolded } from "../store/events.ts";
import { archiveOperation, mutateOperation, readOperation } from "../store/operations.ts";
import { ActionError } from "./errors.ts";
import { windDown, type WinddownDeps } from "./winddown.ts";

export interface AbortPreview {
  /** Tickets whose recorded terminal would be closed. */
  terminals: string[];
  worktrees: Array<{ ticket: string; path: string; dirty: boolean }>;
  live: number;
  queued: number;
  landed: number;
}

/**
 * What abort would tear down, for the confirm dialog. Dirty = non-empty `git status --porcelain`;
 * a lane whose worktree is gone (or not a git checkout) is left out entirely. External lanes are
 * adopted checkouts the board does not own and never removes.
 */
export async function abortPreview(deps: WinddownDeps, opId: string): Promise<AbortPreview> {
  const operation = await readOperation(deps.home, opId);
  const { derived } = await readFolded(deps.home, opId);

  const terminals: string[] = [];
  const worktrees: AbortPreview["worktrees"] = [];
  let queued = 0;
  let landed = 0;
  for (const contact of operation.contacts) {
    const lane = contact.lane;
    const d = derived.contacts[contact.ticket];
    if (d?.landed) landed += 1;
    else if (!lane) queued += 1;
    if (!lane) continue;
    if (lane.terminal && !d?.reaped) terminals.push(contact.ticket);
    if (lane.frontend === "external" || d?.removed) continue;
    if ((await stat(lane.worktree).catch(() => null)) === null) continue;
    const status = await deps.run("git", ["status", "--porcelain"], lane.worktree);
    worktrees.push({ ticket: contact.ticket, path: lane.worktree, dirty: status.code === 0 && status.stdout.trim() !== "" });
  }
  return { terminals, worktrees, live: terminals.length, queued, landed };
}

async function readOpFile(home: string, opId: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(operationDir(home, opId), name), "utf8");
  } catch {
    return null;
  }
}

/**
 * The one way an operation ends, from the page (`close`/`abort` actions) or `/holotable close`.
 * Auto mode and recovery go off first so nothing races the wind-down; then `closed` is appended,
 * the report is written into the directory and `archiveOperation` moves everything (operation.json,
 * events.jsonl, brief.md, seed.json, report.json) under `archive/`. A `closed` event in a still-open
 * directory means an earlier run crashed before archiving: retry from the report step.
 */
export async function endOperation(deps: WinddownDeps, opId: string, outcome: ClosedOutcome): Promise<string> {
  let operation: Operation;
  try {
    operation = await readOperation(deps.home, opId);
  } catch (error) {
    // A missing file is an unknown id; a corrupt one is a real fault.
    if (error instanceof Error && error.message.startsWith("Cannot read")) throw new ActionError(404, "unknown", `No open operation "${opId}"`);
    throw error;
  }
  const { events, derived } = await readFolded(deps.home, opId);
  // `closed` inside a still-open directory is a crashed end: resume at the report step.
  const resume = events.some((e) => e.kind === "closed");
  // An action already running can still record a lane/terminal after the wind-down read.
  if ([...(deps.inFlight?.keys() ?? [])].some((key) => key.startsWith(`${opId}/`)))
    throw new ActionError(409, "busy", "an action is running for this operation");
  if (!resume) {
    if (outcome === "landed") {
      const unlanded = operation.contacts.filter((c) => !derived.contacts[c.ticket]?.landed).length;
      if (unlanded > 0) throw new ActionError(409, "refused", `${unlanded} contacts have not landed`);
    }

    const now = deps.now();
    if (operation.auto?.enabled || operation.recover) {
      await mutateOperation(deps.home, opId, (op) => ({
        ...op,
        auto: op.auto ? { ...op.auto, enabled: false } : undefined,
        recover: false,
      }));
      if (operation.auto?.enabled)
        await appendEvent(deps.home, opId, { v: 1, at: now.toISOString(), kind: "auto", enabled: false, reason: "operation closing", by: "operator" });
      if (operation.recover)
        await appendEvent(deps.home, opId, { v: 1, at: now.toISOString(), kind: "recover", enabled: false, by: "operator" });
    }

    await windDown(deps, opId, outcome === "abandoned" ? "abort" : "close");
    await appendEvent(deps.home, opId, { v: 1, at: deps.now().toISOString(), kind: "closed", outcome });
  }

  const final = await readOperation(deps.home, opId);
  const report = buildReport(final, await readEvents(deps.home, opId), deps.now(), await readOpFile(deps.home, opId, "brief.md"), await readOpFile(deps.home, opId, "notes.md"));
  await writeReport(deps.home, opId, report);
  return archiveOperation(deps.home, opId, deps.now());
}

/** Serializes end runs per operation inside this process: a second request while one runs is a 409. */
export function createEnder(deps: WinddownDeps) {
  const inFlight = new Set<string>();
  const guard = async (opId: string, fn: () => Promise<string>): Promise<string> => {
    if (inFlight.has(opId)) throw new ActionError(409, "busy", `${opId} is already being closed`);
    inFlight.add(opId);
    try {
      return await fn();
    } finally {
      inFlight.delete(opId);
    }
  };
  return {
    preview: (opId: string) => abortPreview(deps, opId),
    close: async (opId: string, outcome: ClosedOutcome) => ({ archived: await guard(opId, () => endOperation(deps, opId, outcome)) }),
    abort: async (opId: string, confirm: unknown): Promise<{ archived: string }> => {
      if (confirm !== opId) throw new ActionError(400, "confirm", "confirm must be the operation id");
      return { archived: await guard(opId, () => endOperation(deps, opId, "abandoned")) };
    },
  };
}
