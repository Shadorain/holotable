import { runCommand as runStoreCommand } from "../commands.ts";
import type { CommandOutcome } from "../commands.ts";
import { holotableCompletions } from "../completions.ts";
import type { CompletionSnapshot } from "../completions.ts";
import { listOperations, readOperation } from "../store/operations.ts";
import { listProjects } from "../store/projects.ts";
import { ensureService, operations, serviceHealth } from "./client.ts";
import type { ServiceHealth } from "./client.ts";
import { holotableToolDefs } from "./tools.ts";
import type { GenericTool } from "./tools.ts";
import { createRun } from "../run.ts";
import { recordRecentRepo } from "../store/recent-repos.ts";
import type { Run } from "../ports.ts";

export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

export interface CommandContext {
  cwd: string;
  /** The host's selected operation; falls back to the core's own selection when omitted. */
  current?: string | null;
}

export interface HolotableCoreDeps {
  home: string;
  now(): Date;
  /** The host's selection, used as the default for commands and tools. */
  current?(): Promise<string | null> | string | null;
  run?: Run;
}

export type HolotableStatus =
  | { running: false }
  | { running: true; operation: string | null; operations: number; live: number; queued: number; attention: number };

export interface HolotableCore {
  runCommand(args: string, ctx: CommandContext): Promise<CommandOutcome>;
  /** Builds a fresh snapshot each call: cheap, and always in step with the store. */
  completions(prefix: string, current?: string | null): Promise<CompletionItem[] | null>;
  completionSnapshot(current?: string | null): Promise<CompletionSnapshot>;
  tools: { state: GenericTool; queue: GenericTool };
  /** Structured live status; hosts render it in their own theme. */
  status(current?: string | null): Promise<HolotableStatus>;
  /** Service health: board.json exists and the service answers with our token. */
  service(): Promise<ServiceHealth>;
  /** Ensures the board service is running and healthy. */
  ensureService(): Promise<ServiceHealth>;
  /** Records the session's git top-level repo into recent-repos.json if inside a git work tree. */
  recordRecent(cwd: string): Promise<void>;
}
/**
 * The host-agnostic plugin core: command surface, model tools, completions, structured status and service
 * discovery. It reads the store directly for CRUD and queries the running service over HTTP for live
 * data; it never starts a server or a watcher.
 */
export function createHolotableCore(deps: HolotableCoreDeps): HolotableCore {
  const { home } = deps;
  const currentOf = async (given: string | null | undefined): Promise<string | null> =>
    given !== undefined ? given : ((await deps.current?.()) ?? null);
  const run = deps.run ?? createRun();
  async function recordRecent(cwd: string): Promise<void> {
    try {
      const res = await run("git", ["rev-parse", "--show-toplevel"], cwd);
      if (res.code === 0 && res.stdout.trim()) {
        await recordRecentRepo(home, res.stdout.trim());
      }
    } catch {
      // Silently degrades if git rev-parse fails or is not a git worktree
    }
  }
  const snapshot = async (current: string | null): Promise<CompletionSnapshot> => {

    const [rows, projects] = await Promise.all([listOperations(home, { archived: true }), listProjects(home)]);
    const op = current ? await readOperation(home, current).catch(() => null) : null;
    return {
      operations: rows.map((row) => ({ id: row.id, name: row.name, archived: row.archived })),
      current: op ? { id: op.id, zones: op.zones.map((z) => z.id), tickets: op.contacts.map((c) => c.ticket) } : null,
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
    };
  };
  return {
    async runCommand(args, ctx) {
      void recordRecent(ctx.cwd);
      return runStoreCommand(args, { home, cwd: ctx.cwd, now: deps.now(), current: await currentOf(ctx.current) });
    },
    async completions(prefix, current) {
      return holotableCompletions(prefix, await snapshot(await currentOf(current)));
    },
    completionSnapshot: async (current) => snapshot(await currentOf(current)),
    tools: holotableToolDefs({ home, current: () => deps.current?.() ?? null, now: deps.now }),
    async status(current) {
      const rows = await operations(home);
      if (rows === null) return { running: false };
      const selected = await currentOf(current);
      const op = rows.find((row) => row.id === selected) ?? (rows.length === 1 ? rows[0] : undefined);
      if (op) return { running: true, operation: op.name, operations: rows.length, live: op.live, queued: op.queued, attention: op.attention };
      let live = 0, queued = 0, attention = 0;
      for (const row of rows) {
        live += row.live;
        queued += row.queued;
        attention += row.attention;
      }
      return { running: true, operation: null, operations: rows.length, live, queued, attention };
    },
    service: () => serviceHealth(home),
    ensureService: () => ensureService({ home }),
    recordRecent,
  };
}
