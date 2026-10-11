import { z, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatUrls } from "../../access.ts";
import { holotableCompletions, type CompletionSnapshot } from "../../completions.ts";
import { KINDS } from "../../core/types.ts";
import { holotableHome } from "../../paths.ts";
import { createHolotableCore, type HolotableCoreDeps } from "../../plugin/core.ts";
import { listOperations, readOperation } from "../../store/operations.ts";
import { listProjects } from "../../store/projects.ts";

const STATUS_KEY = "holotable";
const TOOL_NAMES = ["holotable_state", "holotable_queue"];
const STATUS_MS = 10_000;

/**
 * Thin OMP adapter over the plugin core. The board lives in the `holotable` service: this session only
 * runs the /holotable command surface, exposes the two model tools and mirrors service health into the
 * status row. `/holotable` starts the board service when it is not running; this session never runs a
 * server or a watcher itself. `overrides` is the test seam for that start.
 */
export default function holotableExtension(pi: ExtensionAPI, overrides: Pick<HolotableCoreDeps, "startService"> = {}) {
  // A mission launched by the board must not register any of this.
  if (process.env.OMP_HOLOTABLE_CHILD === "1") return;

  let current: string | null = null;
  let toolsOn = false;
  let timer: Timer | null = null;
  let lastCtx: ExtensionContext | null = null;
  let snapshot: CompletionSnapshot = { operations: [], current: null, projects: [] };
  const core = createHolotableCore({ home: holotableHome(), now: () => new Date(), current: () => current, ...overrides });

  const { state, queue } = core.tools;
  pi.registerTool({
    name: state.name,
    label: state.label,
    description: state.description,
    defaultInactive: true,
    loadMode: "essential",
    approval: "read",
    parameters: z.object({ operation: z.string().optional().describe("Operation id; defaults to the selected one") }),
    async execute(_id, params: { operation?: string }) {
      return { content: [{ type: "text" as const, text: await state.execute(params) }], details: {} };
    },
  });
  pi.registerTool({
    name: queue.name,
    label: queue.label,
    description: queue.description,
    defaultInactive: true,
    approval: "write",
    parameters: z.object({
      operation: z.string().optional(),
      action: z.enum(["add", "update"]),
      ticket: z.string(),
      zone: z.string().optional(),
      kind: z.enum(KINDS).optional(),
      blockedBy: z.array(z.string()).optional(),
      title: z.string().optional(),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text" as const, text: await queue.execute(params as Record<string, unknown>) }], details: {} };
    },
  });

  async function syncTools(enabled: boolean): Promise<void> {
    const active = pi.getActiveTools();
    if (TOOL_NAMES.every((name) => active.includes(name) === enabled)) return;
    await pi.setActiveTools([...active.filter((name) => !TOOL_NAMES.includes(name)), ...(enabled ? TOOL_NAMES : [])]);
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    const home = holotableHome();
    try {
      const [operations, projects] = await Promise.all([listOperations(home, { archived: true }), listProjects(home)]);
      const op = current ? await readOperation(home, current).catch(() => null) : null;
      snapshot = {
        operations: operations.map((row) => ({ id: row.id, name: row.name, archived: row.archived })),
        current: op ? { id: op.id, zones: op.zones.map((z) => z.id), tickets: op.contacts.map((c) => c.ticket) } : null,
        projects: projects.map((p) => ({ id: p.id, name: p.name })),
      };
      ctx.ui.setStatus(STATUS_KEY, await core.status(current));
    } catch {
      // A broken home must not take the command surface down; the next command surfaces it.
      ctx.ui.setStatus(STATUS_KEY, undefined);
      snapshot = { operations: [], current: null, projects: [] };
    }
  }

  /** The status-row timer belongs to a session; rebind it when the session context changes. */
  function schedule(ctx: ExtensionContext): void {
    lastCtx?.clearTimer(timer!);
    timer = toolsOn ? ctx.setInterval(() => void refresh(ctx), STATUS_MS) : null;
  }

  async function showBoard(ctx: ExtensionContext): Promise<void> {
    toolsOn = true;
    schedule(ctx);
    await syncTools(true);
    try {
      const health = await core.ensureService();
      if (health.running) {
        const urls = health.urls && health.urls.length > 0 ? health.urls : health.url ? [health.url] : [];
        ctx.ui.notify(`Board:\n${formatUrls(urls)}\nKeep the full URL private. HTTP is unencrypted; use a trusted network or SSH tunnel.`, "info");
      }
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  pi.registerCommand("holotable", {
    description: "Campaign board over omp-mission missions.",
    getArgumentCompletions: (argumentPrefix: string) => holotableCompletions(argumentPrefix, snapshot),
    handler: async (args: string, ctx: ExtensionContext) => {
      if (ctx.agent.kind === "sub") throw new Error("Use /holotable in the main session.");
      lastCtx = ctx;
      const command = args.trim();
      if (command === "") {
        if (ctx.cwd) void core.recordRecent(ctx.cwd);
        await showBoard(ctx);
        await refresh(ctx);
        return;
      }
      const outcome = await core.runCommand(command, { cwd: ctx.cwd, current });
      if (outcome.current !== undefined) current = outcome.current;
      ctx.ui.notify(outcome.message, "info");
      await refresh(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    schedule(ctx);
    await refresh(ctx);
  });
  const rebind = async (_event: unknown, ctx: ExtensionContext) => {
    lastCtx = ctx;
    schedule(ctx);
    await refresh(ctx);
  };
  pi.on("session_switch", rebind);
  pi.on("session_branch", rebind);
  pi.on("session_shutdown", async () => {
    toolsOn = false;
    lastCtx?.clearTimer(timer!);
    await syncTools(false);
  });
}
