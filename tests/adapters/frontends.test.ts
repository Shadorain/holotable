import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, TerminalRef } from "../../src/core/types.ts";
import { customFrontend } from "../../src/adapters/frontend-custom.ts";
import { herdrFrontend } from "../../src/adapters/frontend-herdr.ts";
import { orcaFrontend } from "../../src/adapters/frontend-orca.ts";
import { gitWorkspaces } from "../../src/adapters/git-workspaces.ts";
import { PortError, type CommandResult, type Run } from "../../src/ports.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holotable-frontend-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface Call {
  command: string;
  args: string[];
  cwd: string;
}

function fakeRun(handler: (call: Call) => CommandResult): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (command, args, cwd) => {
    const call = { command, args, cwd };
    calls.push(call);
    return handler(call);
  };
  return { run, calls };
}

function jsonReply(payload: unknown): CommandResult {
  return { stdout: JSON.stringify(payload), stderr: "", code: 0 };
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", name), "utf8"));
}

const OK = jsonReply({ ok: true, result: {} });

describe("orca frontend", () => {
  test("ensureRepo adds the repo only when unlisted", async () => {
    const withRepo = fakeRun((call) =>
      call.args[1] === "list"
        ? jsonReply({ ok: true, result: { repos: [{ path: "/repo" }] } })
        : OK,
    );
    await orcaFrontend(withRepo.run).ensureRepo("/repo");
    expect(withRepo.calls).toHaveLength(1);

    const without = fakeRun((call) =>
      call.args[1] === "list" ? jsonReply({ ok: true, result: { repos: [] } }) : OK,
    );
    await orcaFrontend(without.run).ensureRepo("/repo");
    expect(without.calls.map((c) => c.args.slice(0, 2))).toEqual([
      ["repo", "list"],
      ["repo", "add"],
    ]);
    expect(without.calls[1].args).toEqual(["repo", "add", "--path", "/repo", "--json"]);
  });

  test("createWorkspace passes args and parses the real envelope", async () => {
    const { run, calls } = fakeRun(() => jsonReply(fixture("orca-worktree-create.json")));
    const created = await orcaFrontend(run).createWorkspace({
      repo: "/repo",
      name: "chr-1",
      base: "main",
      ticket: "CHR-1",
    });
    expect(calls[0].args).toEqual([
      "worktree", "create",
      "--repo", "path:/repo",
      "--name", "chr-1",
      "--base-branch", "main",
      "--linear-issue", "CHR-1",
      "--no-parent", "--json",
    ]);
    expect(created.worktree).toBe("/home/daedalus/projects/charidel/.wt/charidel/holo-env-capture");
    // Orca reports refs/heads/<user>/<name>; the lane stores the short ref.
    expect(created.branch).toBe("Shadorain/holo-env-capture");

    const noTicket = fakeRun(() => jsonReply(fixture("orca-worktree-create.json")));
    await orcaFrontend(noTicket.run).createWorkspace({ repo: "/repo", name: "x", base: "main", ticket: null });
    expect(noTicket.calls[0].args).not.toContain("--linear-issue");
  });

  test("openTerminal builds an env-prefixed quoted command and parses result.terminal", async () => {
    const { run, calls } = fakeRun(() => jsonReply(fixture("orca-terminal-create.json")));
    const ref = await orcaFrontend(run).openTerminal({
      worktree: "/wt",
      title: "alpha Demo",
      argv: ["omp", "/mission alpha"],
      env: { OMP_HOLOTABLE_CHILD: "1", ODD: "a b" },
    });
    expect(ref).toEqual({
      handle: "term_created-0000-4000-8000-000000000000",
      incarnationId: "inc-created-0000-4000-8000-000000000000",
    });
    const args = calls[0].args;
    expect(args.slice(0, 6)).toEqual(["terminal", "create", "--worktree", "path:/wt", "--title", "alpha Demo"]);
    const command = args[args.indexOf("--command") + 1];
    expect(command).toBe("OMP_HOLOTABLE_CHILD='1' ODD='a b' 'omp' '/mission alpha'");
  });

  test("focus re-validates identity before switching", async () => {
    const { run, calls } = fakeRun((call) =>
      call.args[1] === "list" ? jsonReply(fixture("orca-terminal-list.json")) : OK,
    );
    const frontend = orcaFrontend(run);
    const good: TerminalRef = {
      handle: "term_5ed33c02-3de6-4c69-83fc-94038f294ce7",
      incarnationId: "a84a2bfe-7649-4f41-bc7c-5166826b4233",
    };
    await frontend.focus(good, "/home/daedalus/projects/faith-apps");
    expect(calls[1].args).toEqual(["terminal", "switch", "--terminal", good.handle, "--json"]);

    const wrongIncarnation = { ...good, incarnationId: "other" };
    await expect(frontend.focus(wrongIncarnation, "/home/daedalus/projects/faith-apps")).rejects.toMatchObject({
      code: "terminal-missing",
    });
    await expect(frontend.focus(good, "/elsewhere")).rejects.toMatchObject({
      code: "terminal-missing",
    });

    const disconnected: TerminalRef = {
      handle: "term_deadbeef-0000-4000-8000-000000000000",
      incarnationId: "a84a2bfe-0000-4000-8000-000000000000",
    };
    await expect(frontend.focus(disconnected, "/home/daedalus/projects/faith-apps")).rejects.toMatchObject({
      code: "terminal-missing",
    });
    // Only one switch ran: the happy path.
    expect(calls.filter((c) => c.args[1] === "switch")).toHaveLength(1);
  });

  test("close re-validates and uses --tab; argv never contain send or --all", async () => {
    const { run, calls } = fakeRun((call) =>
      call.args[1] === "list" ? jsonReply(fixture("orca-terminal-list.json")) : OK,
    );
    const frontend = orcaFrontend(run);
    const good: TerminalRef = {
      handle: "term_5ed33c02-3de6-4c69-83fc-94038f294ce7",
      incarnationId: "a84a2bfe-7649-4f41-bc7c-5166826b4233",
    };
    await frontend.close(good, "/home/daedalus/projects/faith-apps");
    const closeCall = calls.find((c) => c.args[1] === "close");
    expect(closeCall?.args).toEqual(["terminal", "close", "--terminal", good.handle, "--tab", "--json"]);
    for (const call of calls) {
      expect(call.args).not.toContain("send");
      expect(call.args).not.toContain("--all");
    }
  });

  test("listTerminals maps rows and removeWorkspace selects by path", async () => {
    const { run, calls } = fakeRun((call) =>
      call.args[1] === "list" ? jsonReply(fixture("orca-terminal-list.json")) : OK,
    );
    const frontend = orcaFrontend(run);
    const rows = await frontend.listTerminals();
    expect(rows).toHaveLength(2);
    expect(rows?.[0]).toMatchObject({
      handle: "term_5ed33c02-3de6-4c69-83fc-94038f294ce7",
      worktree: "/home/daedalus/projects/faith-apps",
      connected: true,
    });
    await frontend.removeWorkspace({ repo: "/repo", worktree: "/wt" });
    expect(calls.at(-1)?.args).toEqual(["worktree", "rm", "--worktree", "path:/wt", "--json"]);
  });

  test("envelope failures throw PortError", async () => {
    const bad = fakeRun(() => jsonReply({ ok: false, error: { code: "boom", message: "broke" } }));
    await expect(orcaFrontend(bad.run).listTerminals()).rejects.toBeInstanceOf(PortError);
    const nonZero = fakeRun(() => ({ stdout: "", stderr: "died", code: 2 }));
    await expect(orcaFrontend(nonZero.run).listTerminals()).rejects.toMatchObject({ code: "orca" });
  });
});

describe("herdr frontend", () => {
  const TAB_CREATED = JSON.stringify({ result: { tab: { tab_id: "tab-9" }, root_pane: { pane_id: "pane-3" } } });

  test("openTerminal requires an omp argv", async () => {
    const { run } = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
    await expect(
      herdrFrontend(run).openTerminal({ worktree: "/wt", title: "x", argv: ["bash"], env: {} }),
    ).rejects.toMatchObject({ code: "herdr-needs-omp" });
  });

  test("openTerminal creates a tab then starts the agent by name", async () => {
    const { run, calls } = fakeRun((call) =>
      call.args[1] === "create"
        ? { stdout: TAB_CREATED, stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 0 },
    );
    const ref = await herdrFrontend(run).openTerminal({
      worktree: "/wt",
      title: "alpha Demo",
      argv: ["omp", "/mission alpha"],
      env: { OMP_HOLOTABLE_CHILD: "1" },
    });
    expect(calls[0].args).toEqual([
      "tab", "create", "--cwd", "/wt", "--label", "alpha Demo", "--no-focus", "--env", "OMP_HOLOTABLE_CHILD=1",
    ]);
    expect(calls[1].args).toEqual([
      "agent", "start", "alpha Demo", "--kind", "omp", "--pane", "pane-3", "--timeout", "30000", "--", "/mission alpha",
    ]);
    expect(ref).toEqual({ handle: "alpha Demo", incarnationId: "tab-9" });
  });

  test("a failed agent start closes the tab before rethrowing", async () => {
    const { run, calls } = fakeRun((call) => {
      if (call.args[1] === "create") return { stdout: TAB_CREATED, stderr: "", code: 0 };
      if (call.args[1] === "start") return { stdout: "", stderr: "no pane", code: 1 };
      return { stdout: "", stderr: "", code: 0 };
    });
    await expect(
      herdrFrontend(run).openTerminal({ worktree: "/wt", title: "t", argv: ["omp"], env: {} }),
    ).rejects.toMatchObject({ code: "herdr" });
    expect(calls[2].args).toEqual(["tab", "close", "tab-9"]);
  });

  test("flat herdr ids parse too; focus/close act on the tab id; listTerminals is null", async () => {
    const flat = fakeRun((call) =>
      call.args[1] === "create"
        ? { stdout: JSON.stringify({ result: { tab_id: "t7", pane_id: "p7" } }), stderr: "", code: 0 }
        : { stdout: "", stderr: "", code: 0 },
    );
    const frontend = herdrFrontend(flat.run);
    const ref = await frontend.openTerminal({ worktree: "/wt", title: "t", argv: ["omp"], env: {} });
    expect(ref.incarnationId).toBe("t7");
    await frontend.focus(ref, "/wt");
    await frontend.close(ref, "/wt");
    expect(flat.calls.at(-3)?.args).toEqual(["tab", "focus", "t7"]);
    expect(flat.calls.at(-2)?.args).toEqual(["tab", "get", "t7"]);
    expect(flat.calls.at(-1)?.args).toEqual(["tab", "close", "t7"]);
    expect(await frontend.listTerminals()).toBeNull();
  });
});

describe("custom frontend", () => {
  const custom: Settings = {
    ...DEFAULT_SETTINGS,
    custom: {
      terminal: "mycmd --dir {cwd} --title {title} --run {command}",
      focus: "myfocus {handle}",
      close: "myclose {handle}",
    },
  };

  test("openTerminal fills and shell-quotes the template, parses JSON handle", async () => {
    const { run, calls } = fakeRun(() => ({
      stdout: JSON.stringify({ handle: "h1", incarnationId: "i1" }),
      stderr: "",
      code: 0,
    }));
    const ref = await customFrontend(run, custom).openTerminal({
      worktree: "/wt dir",
      title: "it's",
      argv: ["omp", "/mission x"],
      env: { OMP_X: "a b" },
    });
    expect(ref).toEqual({ handle: "h1", incarnationId: "i1" });
    expect(calls[0].command).toBe("bash");
    expect(calls[0].args[0]).toBe("-lc");
    const filled = calls[0].args[1];
    expect(filled).toContain("--dir '/wt dir'");
    expect(filled).toContain("--title 'it'\\''s'");
    expect(filled).toContain("--run '");
  });

  test("openTerminal accepts the {terminal:{...}} envelope form", async () => {
    const { run } = fakeRun(() => ({
      stdout: JSON.stringify({ terminal: { handle: "h9" } }),
      stderr: "",
      code: 0,
    }));
    const ref = await customFrontend(run, custom).openTerminal({ worktree: "/wt", title: "t", argv: ["omp"], env: {} });
    expect(ref).toEqual({ handle: "h9", incarnationId: "h9" });
  });

  test("empty or absent templates throw custom-not-configured", async () => {
    const { run } = fakeRun(() => ({ stdout: "{}", stderr: "", code: 0 }));
    await expect(
      customFrontend(run, DEFAULT_SETTINGS).openTerminal({ worktree: "/wt", title: "t", argv: ["omp"], env: {} }),
    ).rejects.toMatchObject({ code: "custom-not-configured" });
    const partial: Settings = { ...DEFAULT_SETTINGS, custom: { terminal: "x {cwd}", focus: "", close: "" } };
    await expect(
      customFrontend(run, partial).focus({ handle: "h", incarnationId: "i" }, "/wt"),
    ).rejects.toMatchObject({ code: "custom-not-configured" });
  });

  test("focus and close fill {handle} and run bash -lc", async () => {
    const { run, calls } = fakeRun(() => ({ stdout: "", stderr: "", code: 0 }));
    const frontend = customFrontend(run, custom);
    const ref: TerminalRef = { handle: "h1", incarnationId: "i1" };
    await frontend.focus(ref, "/wt");
    await frontend.close(ref, "/wt");
    expect(calls[0].args[1]).toBe("myfocus 'h1'");
    expect(calls[1].args[1]).toBe("myclose 'h1'");
    expect(await frontend.listTerminals()).toBeNull();
  });
});

describe("gitWorkspaces", () => {
  const realRun: Run = async (command, args, cwd) => {
    const proc = Bun.spawnSync([command, ...args], { cwd });
    return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), code: proc.exitCode ?? 1 };
  };

  async function makeRepo(): Promise<string> {
    const repo = join(tempDir(), "repo");
    const init = Bun.spawnSync(["git", "init", "-q", "-b", "main", repo]);
    if (init.exitCode !== 0) throw new Error("git init failed");
    for (const args of [
      ["config", "user.email", "t@t"],
      ["config", "user.name", "t"],
      ["commit", "-qm", "init", "--allow-empty"],
    ]) {
      const proc = Bun.spawnSync(["git", ...args], { cwd: repo });
      if (proc.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${proc.stderr.toString()}`);
    }
    return repo;
  }

  test("creates a worktree on holotable/<name> and returns its realpath", async () => {
    const repo = await makeRepo();
    const created = await gitWorkspaces(realRun).createWorkspace({ repo, name: "alpha", base: "main", ticket: null });
    expect(created.branch).toBe("holotable/alpha");
    expect(created.worktree).toBe(`${repo}-holotable-alpha`);
    const proc = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: created.worktree });
    expect(proc.stdout.toString().trim()).toBe("holotable/alpha");
  });

  test("places the worktree from the folder template, creating missing parents", async () => {
    const repo = await makeRepo();
    const created = await gitWorkspaces(realRun, "{repo}-lanes/{repoName}/{name}").createWorkspace({ repo, name: "beta", base: "main", ticket: null });
    expect(created.worktree).toBe(`${repo}-lanes/${repo.split("/").pop()}/beta`);
  });

  test("prefers origin/<base> when the remote ref exists", async () => {
    const repo = await makeRepo();
    const ref = Bun.spawnSync(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: repo });
    if (ref.exitCode !== 0) throw new Error("update-ref failed");
    const calls: string[][] = [];
    const run: Run = async (command, args, cwd) => {
      calls.push(args);
      return realRun(command, args, cwd);
    };
    const created = await gitWorkspaces(run).createWorkspace({ repo, name: "b", base: "main", ticket: null });
    const add = calls.find((args) => args[0] === "worktree");
    expect(add?.at(-1)).toBe("origin/main");
    expect(created.branch).toBe("holotable/b");
  });

  test("falls back to the local base ref", async () => {
    const repo = await makeRepo();
    const dev = Bun.spawnSync(["git", "branch", "dev"], { cwd: repo });
    if (dev.exitCode !== 0) throw new Error("branch dev failed");
    const calls: string[][] = [];
    const run: Run = async (command, args, cwd) => {
      calls.push(args);
      return realRun(command, args, cwd);
    };
    await gitWorkspaces(run).createWorkspace({ repo, name: "c", base: "dev", ticket: null });
    const add = calls.find((args) => args[0] === "worktree");
    expect(add?.at(-1)).toBe("dev");
  });

  test("refuses an existing path or branch and unknown bases", async () => {
    const repo = await makeRepo();
    const workspaces = gitWorkspaces(realRun);
    await workspaces.createWorkspace({ repo, name: "alpha", base: "main", ticket: null });
    await expect(
      workspaces.createWorkspace({ repo, name: "alpha", base: "main", ticket: null }),
    ).rejects.toMatchObject({ code: "workspace-exists" });
    await expect(
      workspaces.createWorkspace({ repo, name: "z", base: "nope", ticket: null }),
    ).rejects.toMatchObject({ code: "git" });
  });

  test("removeWorkspace runs git worktree remove --force", async () => {
    const repo = await makeRepo();
    const workspaces = gitWorkspaces(realRun);
    const created = await workspaces.createWorkspace({ repo, name: "gone", base: "main", ticket: null });
    await workspaces.removeWorkspace({ repo, worktree: created.worktree });
    expect(Bun.spawnSync(["test", "-d", created.worktree]).exitCode).toBe(1);
  });
});
