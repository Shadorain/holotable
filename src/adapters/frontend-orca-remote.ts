import { createHash } from "node:crypto";
import type { TerminalRef } from "../core/types.ts";
import { isRecord } from "../core/validate.ts";
import { PortError, type FrontendPort, type Run, type TerminalCommand, type WorkspaceInput } from "../ports.ts";
import { checkOrcaStartupCommand } from "./orca-capabilities.ts";
import { decode, shellQuote } from "./orca-envelope.ts";
import { remoteRelay, type ExecutionHost, type HostSetup, type RelayOps } from "./orca-exec.ts";
import { resolveRemotePlacement } from "./placement.ts";

// Orca frontend for an explicitly placed operation: workspaces/terminals live on
// operation.host ("ssh:<id>" or "runtime:<id>"), routed through authenticated CLI commands and
// `worktree exec`. Identity is host-qualified everywhere — a path on another host never matches.

interface RemoteTerminalRow {
  handle: string;
  incarnationId: string;
  worktreePath: string;
  worktreeId: string | null;
  connected: boolean;
  session: boolean;
  executionHostId: string | null;
}

export interface RemotePlacement {
  host: ExecutionHost;
  /** Resolves the host setup whose checkout owns the operation repo (explicit hostSetup pin wins). */
  setup(repo?: string): Promise<HostSetup>;
  /** Deployed + verified relay anchored at the resolved setup path (cached; resolves setup first). */
  relay(): Promise<RelayOps>;
}

/**
 * Builds the placement context for one remote operation. `host` is required; `hostSetup` pins a
 * specific Orca project-host-setup id when several setups share the same remote path.
 */
export function createRemotePlacement(run: Run, cwd: string, i: { host: ExecutionHost; hostSetup?: string; repo: string }): RemotePlacement {
  const resolved = new Map<string, Promise<HostSetup>>();
  let relayInstance: RelayOps | null = null;

  function setup(repo: string = i.repo): Promise<HostSetup> {
    let pending = resolved.get(repo);
    if (!pending) {
      pending = resolveRemotePlacement(run, cwd, { host: i.host, hostSetup: i.hostSetup, repo }).then((r) => r.setup);
      resolved.set(repo, pending);
    }
    return pending;
  }

  async function relay(): Promise<RelayOps> {
    const anchor = (await setup()).path!;
    relayInstance ??= remoteRelay(run, cwd, { host: i.host, worktree: anchor });
    return relayInstance;
  }

  return { host: i.host, setup, relay };
}

function shellCommand(i: TerminalCommand): string {
  const envPrefix = Object.entries(i.env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `${envPrefix ? `${envPrefix} ` : ""}${i.argv.map(shellQuote).join(" ")}`;
}

function parseTerminalRows(payload: Record<string, unknown>, host: ExecutionHost): {
  rows: RemoteTerminalRow[];
  omittedHosts: string[];
} {
  if (!Array.isArray(payload.terminals)) throw new PortError("orca", "Orca terminal list omitted terminals");
  const scope = isRecord(payload.hostScope) ? payload.hostScope : {};
  const omittedHosts = Array.isArray(scope.omittedHostIds)
    ? scope.omittedHostIds.filter((h): h is string => typeof h === "string")
    : [];
  const rows: RemoteTerminalRow[] = [];
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
      worktreeId: typeof value.worktreeId === "string" ? value.worktreeId : null,
      connected: value.connected === true,
      session: isSession(value.title),
      executionHostId: typeof value.executionHostId === "string" ? value.executionHostId : null,
    });
  }
  return { rows, omittedHosts };
}

const SHELLS: Record<string, true> = { sh: true, bash: true, zsh: true, fish: true, dash: true, ksh: true, mksh: true, tcsh: true, csh: true, nu: true, pwsh: true, xonsh: true, elvish: true };
function isSession(title: unknown): boolean {
  if (typeof title !== "string" || title.trim() === "") return false;
  return !(SHELLS[title.trim().toLowerCase()] === true);
}

export function orcaRemoteFrontend(run: Run, placement: RemotePlacement, cwd = process.cwd(), options: { noTerminal?: boolean } = {}): FrontendPort {
  const host = placement.host;

  /** Global terminal list, filtered strictly to this host; fails loudly on unverifiable inventories. */
  async function terminalRows(): Promise<RemoteTerminalRow[]> {
    const payload = decode(await run("orca", ["terminal", "list", "--json"], cwd));
    const { rows, omittedHosts } = parseTerminalRows(payload, host);
    if (omittedHosts.includes(host))
      throw new PortError("host-offline", `Host ${host} did not answer terminal list; inventory is incomplete`);
    if (rows.some((row) => row.executionHostId === null))
      throw new PortError(
        "host-unverifiable",
        `Orca did not stamp executionHostId on terminal rows; cannot verify they belong to ${host}`,
      );
    return rows.filter((row) => row.executionHostId === host);
  }

  // A handle is valid only for the recorded host, incarnation and checkout.
  async function validatedTerminal(t: TerminalRef, worktree: string): Promise<void> {
    if (t.host !== host)
      throw new PortError("terminal-missing", `Terminal ${t.handle} is not qualified for host ${host}`);
    let wanted = worktree;
    try {
      const relay = await placement.relay();
      wanted = (await relay.realpath(worktree)) ?? worktree;
    } catch {
      // Relay unreachable: fall back to literal path comparison.
    }
    for (const row of await terminalRows()) {
      if (row.handle !== t.handle || row.incarnationId !== t.incarnationId) continue;
      if (t.worktreeId !== undefined && row.worktreeId !== t.worktreeId) continue;
      const matches = row.worktreePath === wanted || row.worktreePath === worktree;
      if (!matches) continue;
      if (!row.connected) throw new PortError("terminal-missing", `Terminal ${t.handle} is disconnected`);
      return;
    }
    throw new PortError("terminal-missing", `Terminal ${t.handle} is gone`);
  }

  async function requireStartupCommand(): Promise<void> {
    const capability = await checkOrcaStartupCommand(run, cwd);
    if (!capability.supported)
      throw new PortError(
        "orca",
        `Orca startup is unavailable (${capability.detail}). Restore the host CLI extension exposing \`orca worktree create --command\`.`,
      );
  }

  /** Deploys the launch wrapper on the mission host (never a local temp file). */
  async function remoteStartupScript(startup: TerminalCommand): Promise<string> {
    const script = `#!/bin/sh\nrm -f -- "$0"\nexec ${shellCommand(startup)}\n`;
    const name = `launch-${createHash("sha256").update(script).digest("hex").slice(0, 8)}.sh`;
    const relay = await placement.relay();
    const res = await relay.request("write", {
      path: name,
      b64: Buffer.from(script, "utf8").toString("base64"),
      mode: 0o700,
    });
    if (typeof res.path !== "string")
      throw new PortError("host-unprepared", "Relay did not return the remote launch script path");
    return res.path;
  }

  async function createWorkspace(i: WorkspaceInput, startup?: TerminalCommand) {
    if (startup) await requireStartupCommand();
    const setup = await placement.setup(i.repo);
    const args = [
      "worktree", "create",
      "--project-host-setup", setup.id,
      "--name", i.name,
      "--base-branch", i.base,
      // Board-owned: native automatic cleanup must not delete live or awaiting-land work.
      "--pinned",
      ...(options.noTerminal ? ["--no-terminal"] : []),
    ];
    if (i.ticket !== null) args.push("--linear-issue", i.ticket);
    if (startup) {
      const scriptPath = await remoteStartupScript(startup);
      args.push("--command", `sh ${shellQuote(scriptPath)}`);
    }
    args.push("--no-parent", "--json");
    const payload = decode(await run("orca", args, cwd));
    const worktree = payload.worktree;
    if (!isRecord(worktree) || typeof worktree.path !== "string")
      throw new PortError("orca", "Orca worktree create omitted result.worktree.path");
    if (typeof worktree.hostId === "string" && worktree.hostId !== host)
      // Never trust a checkout stamped for another host.
      throw new PortError("orca", `Orca created the worktree on ${worktree.hostId}, expected ${host}`);
    const rawBranch = typeof worktree.branch === "string" ? worktree.branch : null;
    return {
      worktree: worktree.path,
      branch: rawBranch === null ? null : rawBranch.replace(/^refs\/heads\//, ""),
      worktreeId: typeof worktree.id === "string" ? worktree.id : undefined,
      startup: payload.startupTerminal,
    };
  }

  return {
    id: "orca",

    async ensureRepo(repo) {
      if (!options.noTerminal) await requireStartupCommand();
      const setup = await placement.setup(repo);
      // Verify the host can serve missions before any workspace mutation: bun probe + relay deploy
      // + ping. The exec anchor is the setup's registered checkout path on the remote host.
      try {
        const relay = await placement.relay();
        await relay.ready();
      } catch (error) {
        if (error instanceof PortError && error.code !== "host-unprepared")
          throw new PortError(
            "host-unprepared",
            `Remote repo ${setup.path ?? repo} is not reachable as an Orca worktree on ${host} (${error.message}). Register the checkout with Orca on that host.`,
          );
        throw error;
      }
    },

    async createWorkspace(i) {
      if (!options.noTerminal) await requireStartupCommand();
      const { worktree, branch, worktreeId } = await createWorkspace(i);
      return { worktree, branch, worktreeId };
    },

    async createWorkspaceWithTerminal(i) {
      if (options.noTerminal) throw new PortError("orca", "A no-terminal frontend cannot attach a workspace terminal");
      await requireStartupCommand();
      const { worktree, branch, worktreeId, startup } = await createWorkspace(i, i.startup);
      if (!isRecord(startup) || typeof startup.handle !== "string")
        throw new PortError("orca", "Orca worktree create omitted result.startupTerminal.handle; CLI needs worktree create --command support");
      for (const row of await terminalRows()) {
        if (row.handle === startup.handle && row.worktreePath === worktree && row.connected)
          return {
            worktree,
            branch,
            worktreeId,
            terminal: { handle: row.handle, incarnationId: row.incarnationId, host, worktreeId: row.worktreeId ?? worktreeId },
          };
      }
      throw new PortError("terminal-missing", `Startup terminal ${startup.handle} is not connected to ${worktree} on ${host}`);
    },

    async openTerminal(i) {
      const command = shellCommand(i);
      // Host-unique selector when the worktree id was recorded; path fallback only for legacy lanes.
      const selector = i.worktreeId ? `id:${i.worktreeId}` : `path:${i.worktree}`;
      const payload = decode(
        await run(
          "orca",
          ["terminal", "create", "--worktree", selector, "--title", i.title, "--command", command, "--json"],
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
      // Verify the new pane is stamped on the right host before recording it.
      for (const row of await terminalRows()) {
        if (
          row.handle === terminal.handle &&
          row.incarnationId === terminal.incarnationId &&
          (i.worktreeId ? row.worktreeId === i.worktreeId : row.worktreePath === i.worktree)
        )
          return {
            handle: terminal.handle,
            incarnationId: terminal.incarnationId,
            host,
            worktreeId: row.worktreeId ?? i.worktreeId,
          };
      }
      throw new PortError("terminal-missing", `New terminal ${terminal.handle} is not visible on host ${host}`);
    },

    async listTerminals() {
      return (await terminalRows()).map((row) => ({
        handle: row.handle,
        incarnationId: row.incarnationId,
        host,
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
      let selector: string | null = i.worktreeId ? `id:${i.worktreeId}` : null;
      if (!selector) {
        // Resolve the worktree id on the correct host; a path alone can name a checkout on any host.
        const payload = decode(await run("orca", ["worktree", "list", "--json"], cwd));
        const scope = isRecord(payload.hostScope) ? payload.hostScope : {};
        const omitted = Array.isArray(scope.omittedHostIds) ? scope.omittedHostIds : [];
        if (omitted.includes(host))
          throw new PortError("host-offline", `Host ${host} did not answer worktree list; cannot remove ${i.worktree}`);
        const matches = (Array.isArray(payload.worktrees) ? payload.worktrees : []).filter(
          (w) =>
            isRecord(w) &&
            typeof w.id === "string" &&
            w.hostId === host &&
            (w.path === i.worktree || (isRecord(w.git) && w.git.path === i.worktree)),
        );
        if (matches.length === 0)
          throw new PortError("workspace-missing", `No registered worktree ${i.worktree} on host ${host}`);
        if (matches.length > 1)
          throw new PortError("workspace-ambiguous", `Multiple worktrees named ${i.worktree} on host ${host}`);
        selector = `id:${(matches[0] as Record<string, unknown>).id}`;
      }
      decode(
        await run(
          "orca",
          [
            "worktree", "rm",
            "--worktree", selector,
            "--host", host,
            ...(i.force ? ["--force"] : []),
            "--json",
          ],
          cwd,
        ),
      );
    },
  };
}
