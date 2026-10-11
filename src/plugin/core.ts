import { runCommand as runStoreCommand, type CommandOutcome, tokenize } from "../commands.ts";
import { holotableCompletions, type CompletionSnapshot } from "../completions.ts";
import { listOperations, readOperation } from "../store/operations.ts";
import { listProjects } from "../store/projects.ts";
import { ensureService, operations, serviceHealth, type ServiceHealth } from "./client.ts";
import { holotableToolDefs, type GenericTool } from "./tools.ts";
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
  /** Starts the board when it is not answering. Tests inject one; the default starts a real service. */
  startService?(): Promise<ServiceHealth>;
  run?: Run;
}

export interface HolotableCore {
  runCommand(args: string, ctx: CommandContext): Promise<CommandOutcome>;
  /** Builds a fresh snapshot each call: cheap, and always in step with the store. */
  completions(prefix: string, current?: string | null): Promise<CompletionItem[] | null>;
  tools: { state: GenericTool; queue: GenericTool };
  /** Status-row text: live service numbers when reachable, an explanation when not. */
  status(current?: string | null): Promise<string>;
  /** Service health: board.json exists and the service answers with our token. */
  service(): Promise<ServiceHealth>;
  /** Ensures the board service is running and healthy. */
  ensureService(): Promise<ServiceHealth>;
  /** Records the session's git top-level repo into recent-repos.json if inside a git work tree. */
  recordRecent(cwd: string): Promise<void>;
}
/**
 * The host-agnostic plugin core: command surface, model tools, completions, status text and service
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
      const first = tokenize(args)[0];
      // The in-session board is gone: lifecycle belongs to the service.
      if (first === "stop")
        return {
          message:
            "The board runs as a service now. Stop it with `holotable uninstall` (systemd) or stop the `holotable serve` process.",
        };
      return runStoreCommand(args, { home, cwd: ctx.cwd, now: deps.now(), current: await currentOf(ctx.current) });
    },
    async completions(prefix, current) {
      return holotableCompletions(prefix, await snapshot(await currentOf(current)));
    },
    tools: holotableToolDefs({ home, current: () => deps.current?.() ?? null, now: deps.now }),
    async status(current) {
      const health = await serviceHealth(home);
      if (!health.running) return "holotable · board not running — /holotable starts it";
      const rows = (await operations(home)) ?? [];
      const open = rows.reduce((sum, row) => sum + row.live, 0);
      const selected = await currentOf(current);
      const op = rows.find((row) => row.id === selected);
      const attention = rows.reduce((sum, row) => sum + row.attention, 0);
      const detail = op ? `${op.name} · ${op.live} live · ${op.queued} queued` : `${rows.length} operations · ${open} live`;
      return `holotable · ${detail} · ${attention} need you`;
    },
    service: () => serviceHealth(home),
    async ensureService() {
      if (!deps.startService) return ensureService({ home });
      const health = await serviceHealth(home);
      return health.running ? health : deps.startService();
    },
    recordRecent,
  };
}
