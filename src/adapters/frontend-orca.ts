import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TerminalRef } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { PortError, type FrontendPort, type Run, type TerminalCommand, type WorkspaceInput } from "../ports.ts";
import { decode, shellQuote } from "./orca-envelope.ts";

interface OrcaTerminalRow {
  handle: string;
  incarnationId: string;
  worktreePath: string;
  connected: boolean;
  session: boolean;
}

const SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true, fish: true, dash: true, ksh: true, mksh: true, tcsh: true, csh: true, nu: true, pwsh: true, xonsh: true, elvish: true };

/**
 * Orca leaves an idle default shell (untitled, or titled after the shell) and the "Setup" tab that ran
 * the worktree's setup hook (worktree create, local and remote) in a worktree. Omp titles its pane
 * "π …"; any other title may be a session still starting, so it counts as one.
 */
function isSession(title: unknown): boolean {
  if (title === null || title === undefined) return false;
  if (typeof title !== "string") return true;
  const name = title.trim();
  if (name === "" || name === "Setup") return false;
  return SHELLS[name.split("/").at(-1) as string] !== true;
}

function parseTerminalList(payload: Record<string, unknown>): OrcaTerminalRow[] {
  if (!Array.isArray(payload.terminals))
    throw new PortError("orca", "Orca terminal list omitted terminals");
  const rows: OrcaTerminalRow[] = [];
  for (const value of payload.terminals) {
    if (!isRecord(value)) throw new PortError("orca", "Orca terminal list contains invalid terminal");
    if (
      typeof value.handle !== "string" ||
      typeof value.incarnationId !== "string" ||
      typeof value.worktreePath !== "string"
    )
      throw new PortError("orca", "Orca terminal lacks identity fields");
    rows.push({
      handle: value.handle,
      incarnationId: value.incarnationId,
      worktreePath: value.worktreePath,
      connected: value.connected === true,
      session: isSession(value.title),
    });
  }
  return rows;
}

function shellCommand(i: TerminalCommand): string {
  const envPrefix = Object.entries(i.env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `${envPrefix ? `${envPrefix} ` : ""}${i.argv.map(shellQuote).join(" ")}`;
}

export function orcaFrontend(run: Run): FrontendPort {
  const cwd = process.cwd(); // orca commands do not depend on the caller cwd

  async function terminalRows(): Promise<OrcaTerminalRow[]> {
    return parseTerminalList(decode(await run("orca", ["terminal", "list", "--json"], cwd)));
  }

  // A handle alone is not enough: incarnationId and worktreePath must match a
  // connected row or the recorded terminal is stale/missing.
  async function validatedTerminal(t: TerminalRef, worktree: string): Promise<void> {
    const wanted = await realpath(worktree).catch(() => worktree);
    for (const row of await terminalRows()) {
      const rowPath = await realpath(row.worktreePath).catch(() => row.worktreePath);
      if (row.handle === t.handle && row.incarnationId === t.incarnationId && rowPath === wanted) {
        if (!row.connected)
          throw new PortError("terminal-missing", `Terminal ${t.handle} is disconnected`);
        return;
      }
    }
    throw new PortError("terminal-missing", `Terminal ${t.handle} is gone`);
  }
  async function createWorkspace(i: WorkspaceInput, startup?: TerminalCommand) {
    const args = [
      "worktree", "create",
      "--repo", `path:${i.repo}`,
      "--name", i.name,
      "--base-branch", i.base,
    ];
    if (i.ticket !== null) args.push("--linear-issue", i.ticket);
    if (startup) {
      // The setup/startup wrapper can exceed terminal line limits with a long mission scope.
      const dir = await mkdtemp(join(tmpdir(), "holotable-orca-start-"));
      const script = join(dir, "launch.sh");
      await writeFile(script, `#!/bin/sh\nrm -f -- ${shellQuote(script)}\nrmdir -- ${shellQuote(dir)}\nexec env ${shellCommand(startup)}\n`, { mode: 0o700 });
      args.push("--command", `sh ${shellQuote(script)}`);
    }
    args.push("--no-parent", "--json");
    const payload = decode(await run("orca", args, cwd));
    const worktree = payload.worktree;
    if (!isRecord(worktree) || typeof worktree.path !== "string")
      throw new PortError("orca", "Orca worktree create omitted result.worktree.path");
    const rawBranch = typeof worktree.branch === "string" ? worktree.branch : null;
    return {
      worktree: worktree.path,
      branch: rawBranch === null ? null : rawBranch.replace(/^refs\/heads\//, ""),
      startup: payload.startupTerminal,
    };
  }

  return {
    id: "orca",

    async ensureRepo(repo) {
      const wanted = await realpath(repo).catch(() => repo);
      const listed = decode(await run("orca", ["repo", "list", "--json"], cwd));
      const repos = Array.isArray(listed.repos) ? listed.repos : [];
      for (const entry of repos) {
        if (isRecord(entry) && typeof entry.path === "string") {
          const entryPath = await realpath(entry.path).catch(() => entry.path);
          if (entryPath === wanted) return;
        }
      }
      decode(await run("orca", ["repo", "add", "--path", repo, "--json"], cwd));
    },

    async createWorkspace(i) {
      const { worktree, branch } = await createWorkspace(i);
      return { worktree, branch };
    },

    async createWorkspaceWithTerminal(i) {
      const { worktree, branch, startup } = await createWorkspace(i, i.startup);
      if (!isRecord(startup) || typeof startup.handle !== "string")
        throw new PortError("orca", "Orca worktree create omitted result.startupTerminal.handle; CLI needs worktree create --command support");
      const wanted = await realpath(worktree).catch(() => worktree);
      for (const row of await terminalRows()) {
        const path = await realpath(row.worktreePath).catch(() => row.worktreePath);
        if (row.handle === startup.handle && path === wanted && row.connected)
          return { worktree, branch, terminal: { handle: row.handle, incarnationId: row.incarnationId } };
      }
      throw new PortError("terminal-missing", `Startup terminal ${startup.handle} is not connected to ${worktree}`);
    },

    async openTerminal(i) {
      const command = shellCommand(i);
      const payload = decode(
        await run(
          "orca",
          ["terminal", "create", "--worktree", `path:${i.worktree}`, "--title", i.title, "--command", command, "--json"],
          cwd,
        ),
      );
      const terminal = payload.terminal;
      if (
        !isRecord(terminal) ||
        typeof terminal.handle !== "string" ||
        typeof terminal.incarnationId !== "string"
      )
        throw new PortError("orca", "Orca terminal create omitted result.terminal handle or incarnationId");
      return { handle: terminal.handle, incarnationId: terminal.incarnationId };
    },

    async listTerminals() {
      return (await terminalRows()).map((row) => ({
        handle: row.handle,
        incarnationId: row.incarnationId,
        worktree: row.worktreePath,
        connected: row.connected,
        session: row.session,
      }));
    },

    async focus(t, worktree) {
      await validatedTerminal(t, worktree);
      decode(await run("orca", ["terminal", "switch", "--terminal", t.handle, "--json"], cwd));
    },

    async close(t, worktree) {
      await validatedTerminal(t, worktree);
      decode(await run("orca", ["terminal", "close", "--terminal", t.handle, "--tab", "--json"], cwd));
    },

    async removeWorkspace(i) {
      decode(await run("orca", ["worktree", "rm", "--worktree", `path:${i.worktree}`, "--json"], cwd));
    },
  };
}
