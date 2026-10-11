import type { Settings, TerminalRef } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { PortError, type FrontendPort, type Run } from "../ports.ts";
import { gitWorkspaces } from "./git-workspaces.ts";

// Custom frontend: operator-supplied shell templates with shell-quoted
// placeholders {cwd} {title} {command} / {handle}, as omp-mission's fillCommand.

function fillCommand(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(cwd|title|command|handle)\}/g, (token, key: string) => {
    if (!(key in vars)) throw new PortError("custom", `custom command placeholder ${token} is not available`);
    return `'${(vars[key] ?? "").replaceAll("'", "'\\''")}'`;
  });
}

function fail(result: { code: number; stderr: string; stdout: string }, label: string): void {
  if (result.code === 0) return;
  throw new PortError("custom", result.stderr.trim() || result.stdout.trim() || `${label} failed (${result.code})`);
}

function requireTemplate(custom: Settings["custom"], field: "terminal" | "focus" | "close"): string {
  const template = custom?.[field];
  if (!template)
    throw new PortError(
      "custom-not-configured",
      `Run /holotable config custom.${field} … to configure the custom frontend`,
    );
  return template;
}

export function customFrontend(run: Run, settings: Settings): FrontendPort {
  const workspaces = gitWorkspaces(run, settings.worktrees.root);
  return {
    id: "custom",
    ensureRepo: workspaces.ensureRepo,
    createWorkspace: workspaces.createWorkspace,
    removeWorkspace: workspaces.removeWorkspace,

    async openTerminal(i) {
      const command = `${Object.entries(i.env)
        .map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`)
        .join(" ")} ${i.argv.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(" ")}`.trim();
      const filled = fillCommand(requireTemplate(settings.custom, "terminal"), {
        cwd: i.worktree,
        title: i.title,
        command,
        handle: "",
      });
      const result = await run("bash", ["-lc", filled], i.worktree);
      fail(result, "custom terminal");
      let payload: unknown;
      try {
        payload = JSON.parse(result.stdout);
      } catch {
        throw new PortError("custom", "custom terminal must print JSON { handle, incarnationId }");
      }
      const row = isRecord(payload) && isRecord(payload.result) ? payload.result : payload;
      const terminal = isRecord(row) && isRecord(row.terminal) ? row.terminal : row;
      if (!isRecord(terminal) || typeof terminal.handle !== "string" || !terminal.handle)
        throw new PortError("custom", "custom terminal JSON omitted handle");
      const incarnationId =
        typeof terminal.incarnationId === "string" && terminal.incarnationId
          ? terminal.incarnationId
          : typeof terminal.incarnation_id === "string" && terminal.incarnation_id
            ? terminal.incarnation_id
            : terminal.handle;
      return { handle: terminal.handle, incarnationId };
    },

    // A custom frontend cannot enumerate terminals.
    async listTerminals() {
      return null;
    },

    async focus(t: TerminalRef, worktree: string) {
      const filled = fillCommand(requireTemplate(settings.custom, "focus"), {
        cwd: worktree,
        title: "",
        command: "",
        handle: t.handle,
      });
      fail(await run("bash", ["-lc", filled], worktree), "custom focus");
    },

    async close(t: TerminalRef, worktree: string) {
      const filled = fillCommand(requireTemplate(settings.custom, "close"), {
        cwd: worktree,
        title: "",
        command: "",
        handle: t.handle,
      });
      fail(await run("bash", ["-lc", filled], worktree), "custom close");
    },
  };
}
