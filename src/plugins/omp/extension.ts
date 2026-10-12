import { z } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import type { SymbolKey } from "@oh-my-pi/pi-tui/theme";
import { holotableCompletions } from "../../completions.ts";
import type { CompletionSnapshot } from "../../completions.ts";
import { KINDS } from "../../core/types.ts";
import { holotableHome } from "../../paths.ts";
import type { HolotableCore, HolotableStatus } from "../../plugin/core.ts";
import type { Run } from "../../ports.ts";

const STATUS_KEY = "holotable";
const TOOL_NAMES = ["holotable_state", "holotable_queue"];
const STATUS_MS = 10_000;

function statusText(status: HolotableStatus, theme: Theme): string | undefined {
  if (status.running && status.operations === 0) return undefined;
  const glyph = (key: SymbolKey, fallback: string) =>
    typeof theme.symbol === "function" ? theme.symbol(key) || fallback : fallback;
  const separator = ` ${theme.fg("dim", glyph("sep.dot", "·").trim() || "·")} `;
  const rail = theme.fg("accent", glyph("advisor.rail", "▎"));
  const icon = theme.fg("accent", glyph("cmd.compass", "⌖"));
  if (!status.running) {
    return `${rail} ${icon} ${theme.fg("warning", "board offline")}${separator}${theme.fg("dim", "/holotable")}`;
  }
  const name = status.operation?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const parts = [theme.fg("accent", name || `${status.operations} operations`)];
  if (status.live) parts.push(theme.fg("success", `${glyph("status.running", "⟳")} ${status.live} live`));
  if (status.queued) parts.push(theme.fg("muted", `${glyph("status.pending", "○")} ${status.queued} queued`));
  if (status.attention) parts.push(theme.fg("warning", `${glyph("status.warning", "!")} ${status.attention} need you`));
  return `${rail} ${icon} ${parts.join(separator)}`;
}

/** Explicit commands use the bundled CLI; passive reads stay in-process to avoid polling subprocesses. */
export default function holotableExtension(pi: ExtensionAPI, overrides: { run?: Run } = {}) {
  // A mission launched by the board must not register any of this.
  if (process.env.OMP_HOLOTABLE_CHILD === "1") return;

  let current: string | null = null;
  let activated = false;
  let registered = false;
  let generation = 0;
  let corePromise: Promise<HolotableCore> | null = null;
  let timer: Timer | null = null;
  let lastCtx: ExtensionContext | null = null;
  let snapshot: CompletionSnapshot = { operations: [], current: null, projects: [] };
  const getCore = () => corePromise ??= import("../../plugin/core.ts").then(({ createHolotableCore }) =>
    createHolotableCore({ home: holotableHome(), now: () => new Date(), current: () => current }));

  function registerTools(core: HolotableCore): void {
    if (registered) return;
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
    registered = true;
  }

  async function syncTools(enabled: boolean): Promise<void> {
    const active = pi.getActiveTools();
    if (TOOL_NAMES.every((name) => active.includes(name) === enabled)) return;
    await pi.setActiveTools([...active.filter((name) => !TOOL_NAMES.includes(name)), ...(enabled ? TOOL_NAMES : [])]);
  }

  async function refresh(ctx: ExtensionContext): Promise<void> {
    if (!activated || ctx !== lastCtx) return;
    const version = generation;
    try {
      const core = await getCore();
      const [nextSnapshot, status] = await Promise.all([core.completionSnapshot(current), core.status(current)]);
      if (!activated || version !== generation || ctx !== lastCtx) return;
      snapshot = nextSnapshot;
      ctx.ui.setStatus(STATUS_KEY, statusText(status, ctx.ui.theme));
    } catch {
      if (!activated || version !== generation || ctx !== lastCtx) return;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      snapshot = { operations: [], current: null, projects: [] };
    }
  }

  /** The status-row timer belongs to a session; rebind it when the session context changes. */
  function schedule(ctx: ExtensionContext): void {
    if (timer !== null) lastCtx?.clearTimer(timer);
    lastCtx = ctx;
    timer = activated ? ctx.setInterval(() => void refresh(ctx), STATUS_MS) : null;
  }


  pi.registerCommand("holotable", {
    description: "Campaign board over omp-mission missions.",
    getArgumentCompletions: (argumentPrefix: string) => holotableCompletions(argumentPrefix, snapshot),
    handler: async (args: string, ctx: ExtensionContext) => {
      if (ctx.agent.kind === "sub") throw new Error("Use /holotable in the main session.");
      const version = generation;
      const core = await getCore();
      if (version !== generation) return;
      registerTools(core);
      activated = true;
      await syncTools(true);
      if (version !== generation) return;
      schedule(ctx);
      const [{ runHolotable }, { tokenize }] = await Promise.all([
        import("../../adapters/holotable-cli.ts"), import("../../commands.ts"),
      ]);
      const tokens = tokenize(args.trim());
      const outcome = await runHolotable(tokens.length ? tokens : ["start"], {
        home: holotableHome(), cwd: ctx.cwd, current, run: overrides.run,
      });
      if (version !== generation) return;
      if (outcome.current !== undefined) {
        current = outcome.current;
        generation += 1;
      }
      ctx.ui.notify(outcome.message, "info");
      if (tokens[0] === "stop" && outcome.service?.running === false) {
        await deactivate(ctx);
        return;
      }
      await refresh(ctx);
    },
  });

  const deactivate = async (ctx: ExtensionContext) => {
    generation += 1;
    activated = false;
    snapshot = { operations: [], current: null, projects: [] };
    schedule(ctx);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (registered) await syncTools(false);
  };
  const reset = (_event: unknown, ctx: ExtensionContext) => {
    current = null;
    return deactivate(ctx);
  };
  pi.on("session_start", reset);
  pi.on("session_switch", reset);
  pi.on("session_branch", reset);
  pi.on("session_shutdown", reset);
}
