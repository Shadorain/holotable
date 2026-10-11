import { realpath } from "node:fs/promises";
import type { TerminalRef } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { PortError, type FrontendPort, type Run } from "../ports.ts";
import { decode, shellQuote } from "./orca-envelope.ts";

interface OrcaTerminalRow {
  handle: string;
  incarnationId: string;
  worktreePath: string;
  connected: boolean;
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
    });
  }
  return rows;
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
      const args = [
        "worktree", "create",
        "--repo", `path:${i.repo}`,
        "--name", i.name,
        "--base-branch", i.base,
      ];
      if (i.ticket !== null) args.push("--linear-issue", i.ticket);
      args.push("--no-parent", "--json");
      const payload = decode(await run("orca", args, cwd));
      const worktree = payload.worktree;
      if (!isRecord(worktree) || typeof worktree.path !== "string")
        throw new PortError("orca", "Orca worktree create omitted result.worktree.path");
      const rawBranch = typeof worktree.branch === "string" ? worktree.branch : null;
      return {
        worktree: worktree.path,
        branch: rawBranch === null ? null : rawBranch.replace(/^refs\/heads\//, ""),
      };
    },

    async openTerminal(i) {
      const envPrefix = Object.entries(i.env)
        .map(([key, value]) => `${key}=${shellQuote(value)}`)
        .join(" ");
      const command = `${envPrefix ? `${envPrefix} ` : ""}${i.argv.map(shellQuote).join(" ")}`;
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
