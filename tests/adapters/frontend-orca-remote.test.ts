import { describe, expect, test } from "bun:test";
import { orcaRemoteFrontend, type RemotePlacement } from "../../src/adapters/frontend-orca-remote.ts";
import type { HostSetup, RelayOps } from "../../src/adapters/orca-exec.ts";
import type { Run } from "../../src/ports.ts";
const host = "ssh:west";
const placement: RemotePlacement = {
  host,
  setup: async () => { throw new Error("unexpected setup lookup"); },
  relay: async () => { throw new Error("relay unavailable"); },
};


function terminalList(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    terminals: [{
      handle: "reused-handle",
      incarnationId: "inc-1",
      worktreePath: "/remote/wt",
      worktreeId: "remote-worktree-id",
      connected: true,
      title: "OMP",
      executionHostId: host,
    }],
    ...over,
  });
}

describe("orcaRemoteFrontend", () => {
  test("returns host and checkout identity for a startup terminal", async () => {
    const setup: HostSetup = { id: "setup-1", projectId: "project-1", repoId: "repo-1", hostId: host, path: "/remote/repo", state: "ready" };
    const relay: RelayOps = {
      ready: async () => undefined,
      request: async () => ({ path: "/remote/launch.sh" }),
      run: async () => ({ stdout: "", stderr: "", code: 0 }),
      realpath: async (path) => path,
    };
    const startupPlacement: RemotePlacement = { host, setup: async () => setup, relay: async () => relay };
    const run: Run = async (_command, args) => {
      if (args.join(" ") === "worktree create --help")
        return { stdout: "--command <command>", stderr: "", code: 0 };
      if (args[0] === "worktree" && args[1] === "create")
        return {
          stdout: JSON.stringify({
            worktree: { path: "/remote/wt", branch: "feature", id: "remote-worktree-id", hostId: host },
            startupTerminal: { handle: "startup-handle" },
          }),
          stderr: "",
          code: 0,
        };
      return {
        stdout: terminalList({
          terminals: [{
            handle: "startup-handle",
            incarnationId: "startup-inc",
            worktreePath: "/remote/wt",
            worktreeId: "remote-worktree-id",
            connected: true,
            title: "OMP",
            executionHostId: host,
          }],
        }),
        stderr: "",
        code: 0,
      };
    };
    const frontend = orcaRemoteFrontend(run, startupPlacement, "/board");

    await expect(frontend.createWorkspaceWithTerminal!({
      repo: "/repo",
      name: "feature",
      base: "main",
      ticket: null,
      startup: { argv: ["omp"], env: {} },
    })).resolves.toMatchObject({
      worktree: "/remote/wt",
      worktreeId: "remote-worktree-id",
      terminal: { host, worktreeId: "remote-worktree-id" },
    });
  });
  test("refuses a stored terminal reference qualified for another host", async () => {
    const calls: string[][] = [];
    const run: Run = async (_command, args) => {
      calls.push(args);
      return { stdout: terminalList(), stderr: "", code: 0 };
    };
    const frontend = orcaRemoteFrontend(run, placement, "/board");

    await expect(
      frontend.close({ handle: "reused-handle", incarnationId: "inc-1", host: "ssh:east" }, "/remote/wt"),
    ).rejects.toMatchObject({ code: "terminal-missing" });
    expect(calls).toEqual([]);
  });

  test("returns host and worktree identity for newly opened terminals", async () => {
    const calls: string[][] = [];
    const run: Run = async (_command, args) => {
      calls.push(args);
      return args[0] === "terminal" && args[1] === "create"
        ? { stdout: JSON.stringify({ terminal: { handle: "reused-handle", incarnationId: "inc-1" } }), stderr: "", code: 0 }
        : { stdout: terminalList(), stderr: "", code: 0 };
    };
    const frontend = orcaRemoteFrontend(run, placement, "/board");

    await expect(frontend.openTerminal({
      worktree: "/remote/wt",
      worktreeId: "remote-worktree-id",
      title: "OMP",
      argv: ["omp"],
      env: {},
    })).resolves.toEqual({
      handle: "reused-handle",
      incarnationId: "inc-1",
      host,
      worktreeId: "remote-worktree-id",
    });
  });

  test("pins remote removal to its host and forces only when requested", async () => {
    const calls: string[][] = [];
    const run: Run = async (_command, args) => {
      calls.push(args);
      return { stdout: "{}", stderr: "", code: 0 };
    };
    const frontend = orcaRemoteFrontend(run, placement, "/board");

    await frontend.removeWorkspace({ repo: "/repo", worktree: "/remote/wt", worktreeId: "wt-id" });
    await frontend.removeWorkspace({ repo: "/repo", worktree: "/remote/wt", worktreeId: "wt-id", force: true });
    expect(calls).toEqual([
      ["worktree", "rm", "--worktree", "id:wt-id", "--host", host, "--json"],
      ["worktree", "rm", "--worktree", "id:wt-id", "--host", host, "--force", "--json"],
    ]);
  });
});
