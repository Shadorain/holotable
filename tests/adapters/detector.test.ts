import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRepo, listRepoRows, orcaRepos } from "../../src/adapters/detector.ts";
import type { CommandResult, Run } from "../../src/ports.ts";
import { recordRecentRepo, readRecentRepos } from "../../src/store/recent-repos.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holotable-detect-"));
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
const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", code: 0 });
const fail = (code = 1, stderr = ""): CommandResult => ({ stdout: "", stderr, code });

function fakeRun(handler: (call: Call) => CommandResult | null): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (command, args, cwd) => {
    const call = { command, args, cwd };
    calls.push(call);
    return handler(call) ?? { stdout: "", stderr: "not found", code: 127 };
  };
  return { run, calls };
}

/** Baseline: a git repo with origin/HEAD=origin/main on main, github remote, gh + lin signed in, no orca, no herdr. */
function baseRun(repo: string): { run: Run; calls: Call[] } {
  return fakeRun((call) => {
    const { command, args, cwd } = call;
    if (command === "git" && args[0] === "rev-parse") return ok(`${cwd}\n`);
    if (command === "git" && args[0] === "symbolic-ref") return ok("origin/main\n");
    if (command === "git" && args[0] === "branch") return ok("main\n");
    if (command === "git" && args[0] === "remote") return ok("git@github.com:acme/demo.git\n");
    if (command === "gh") return ok();
    if (command === "lin") return ok("{}");
    if (command === "orca") return fail(127, "command not found");
    if (command === "herdr") return fail(127, "command not found");
    return null;
  });
}

describe("detectRepo", () => {
  test("repo not inside a git work tree throws a clear error", async () => {
    const dir = tempDir();
    const { run } = fakeRun(() => fail(128, "fatal: not a git repository"));
    await expect(detectRepo(dir, run)).rejects.toThrow("not inside a git work tree");
  });

  test("base falls back: orca ref, then remote HEAD, then current branch, then main", async () => {
    const dir = tempDir();
    // orca knows it: worktreeBaseRef wins, stripped of origin/
    const { run: r1 } = fakeRun((call) => {
      const { command, args } = call;
      if (command === "git" && args[0] === "rev-parse") return ok(`${dir}\n`);
      if (command === "orca" && args[0] === "repo")
        return ok(JSON.stringify({ repos: [{ path: dir, displayName: "Demo", worktreeBaseRef: "origin/dev", worktreeBasePath: "/wt" }] }));
      if (command === "git" && args[0] === "symbolic-ref") return ok("origin/main\n");
      if (command === "git" && args[0] === "branch") return ok("feature\n");
      if (command === "git" && args[0] === "remote") return ok("https://github.com/acme/demo\n");
      if (command === "gh") return ok();
      if (command === "lin") return ok();
      if (command === "herdr") return fail(127);
      return null;
    });
    const d1 = await detectRepo(dir, r1);
    expect(d1.fields.base).toBe("dev");
    expect(d1.reasons.base).toContain("Orca");
    expect(d1.fields.name).toBe("Demo");
    expect(d1.fields.frontend).toBe("orca");
    // orca places worktrees itself: no holotable worktree template on an orca frontend
    expect(d1.fields.worktreeRoot).toBeUndefined();

    // no orca: remote HEAD wins over the current branch
    const { run: r2 } = fakeRun((call) => {
      const { command, args } = call;
      if (command === "git" && args[0] === "rev-parse") return ok(`${dir}\n`);
      if (command === "orca") return fail(127);
      if (command === "git" && args[0] === "symbolic-ref") return ok("origin/develop\n");
      if (command === "git" && args[0] === "branch") return ok("feature\n");
      if (command === "git" && args[0] === "remote") return ok("https://gitlab.com/x/y\n");
      if (command === "gh") return fail(1, "not logged in");
      if (command === "lin") return fail(1);
      if (command === "herdr") return fail(127);
      return null;
    });
    const d2 = await detectRepo(dir, r2);
    expect(d2.fields.base).toBe("develop");
    expect(d2.fields.name).toBe(dir.split("/").pop() as string);
    expect(d2.fields.frontend).toBe("none");
    expect(d2.fields.tracker).toBe("none");
    expect(d2.fields.delivery).toBe("local-merge");

    // no remote HEAD either: current branch
    const { run: r3 } = fakeRun((call) => {
      const { command, args } = call;
      if (command === "git" && args[0] === "rev-parse") return ok(`${dir}\n`);
      if (command === "orca") return fail(127);
      if (command === "git" && args[0] === "symbolic-ref") return fail(1);
      if (command === "git" && args[0] === "branch") return ok("topic\n");
      if (command === "git" && args[0] === "remote") return fail(1);
      if (command === "gh") return fail(1);
      if (command === "lin") return fail(1);
      if (command === "herdr") return fail(127);
      return null;
    });
    const d3 = await detectRepo(dir, r3);
    expect(d3.fields.base).toBe("topic");
    expect(d3.reasons.base).toContain("Current branch");

    // detached head too: main
    const { run: r4 } = fakeRun((call) => {
      const { command, args } = call;
      if (command === "git" && args[0] === "rev-parse") return ok(`${dir}\n`);
      if (command === "orca") return fail(127);
      if (command === "git" && args[0] === "symbolic-ref") return fail(1);
      if (command === "git" && args[0] === "branch") return ok("\n");
      if (command === "git" && args[0] === "remote") return fail(1);
      if (command === "gh") return fail(1);
      if (command === "lin") return fail(1);
      if (command === "herdr") return fail(127);
      return null;
    });
    const d4 = await detectRepo(dir, r4);
    expect(d4.fields.base).toBe("main");
    expect(d4.reasons.base).toBeTruthy();
  });


  test("tracker: linear wins over github; github needs github origin plus gh auth", async () => {
    const dir = tempDir();
    const { run } = baseRun(dir);
    const d = await detectRepo(dir, run);
    expect(d.fields.tracker).toBe("linear");
    expect(d.fields.delivery).toBe("github-pr");
    expect(d.fields.integration).toBe(dir);
    expect(d.fields.fleet).toBe("omp-mission");
    expect(d.fields.pause).toBeUndefined();
    expect(d.reasons.pause).toBeUndefined();

    // lin absent, github origin + gh signed in → github tracker
    const { run: r2 } = fakeRun((call) => {
      const { command, args } = call;
      if (command === "git" && args[0] === "rev-parse") return ok(`${dir}\n`);
      if (command === "orca") return fail(127);
      if (command === "git" && args[0] === "symbolic-ref") return ok("origin/main\n");
      if (command === "git" && args[0] === "branch") return ok("main\n");
      if (command === "git" && args[0] === "remote") return ok("https://github.com/acme/demo\n");
      if (command === "gh") return ok();
      if (command === "lin") return fail(127);
      if (command === "herdr") return fail(127);
      return null;
    });
    const d2 = await detectRepo(dir, r2);
    expect(d2.fields.tracker).toBe("github");
    expect(d2.fields.delivery).toBe("github-pr");

    // github origin but gh not signed in → tracker none, delivery local-merge
    const { run: r3 } = fakeRun((call) => {
      const { command, args } = call;
      if (command === "git" && args[0] === "rev-parse") return ok(`${dir}\n`);
      if (command === "orca") return fail(127);
      if (command === "git" && args[0] === "symbolic-ref") return ok("origin/main\n");
      if (command === "git" && args[0] === "branch") return ok("main\n");
      if (command === "git" && args[0] === "remote") return ok("https://github.com/acme/demo\n");
      if (command === "gh") return fail(1, "You are not logged in");
      if (command === "lin") return fail(127);
      if (command === "herdr") return fail(127);
      return null;
    });
    const d3 = await detectRepo(dir, r3);
    expect(d3.fields.tracker).toBe("none");
    expect(d3.fields.delivery).toBe("local-merge");
  });

  test("frontend: herdr when installed and repo unknown to orca", async () => {
    const dir = tempDir();
    const { run } = fakeRun((call) => {
      const { command, args } = call;
      if (command === "git" && args[0] === "rev-parse") return ok(`${dir}\n`);
      if (command === "orca" && args[0] === "repo") return ok(JSON.stringify({ repos: [] }));
      if (command === "git" && args[0] === "symbolic-ref") return ok("origin/main\n");
      if (command === "git" && args[0] === "branch") return ok("main\n");
      if (command === "git" && args[0] === "remote") return ok("https://github.com/acme/demo\n");
      if (command === "gh") return ok();
      if (command === "lin") return ok();
      if (command === "herdr" && args[0] === "--version") return ok("herdr 1.0.0");
      return null;
    });
    const d = await detectRepo(dir, run);
    expect(d.fields.frontend).toBe("herdr");
    expect(d.reasons.frontend).toContain("Herdr");
  });

  test("a subdirectory of the repo detects at the top level", async () => {
    const dir = tempDir();
    const sub = join(dir, "src", "deep");
    mkdirSync(sub, { recursive: true });
    const { run } = fakeRun((call) => {
      const { command, args } = call;
      if (command === "git" && args[0] === "rev-parse") return ok(`${dir}\n`);
      if (command === "orca") return fail(127);
      if (command === "git" && args[0] === "symbolic-ref") return ok("origin/main\n");
      if (command === "git" && args[0] === "branch") return ok("main\n");
      if (command === "git" && args[0] === "remote") return ok("https://github.com/acme/demo\n");
      if (command === "gh") return ok();
      if (command === "lin") return ok();
      if (command === "herdr") return fail(127);
      return null;
    });
    const d = await detectRepo(sub, run);
    expect(d.fields.integration).toBe(dir);
    expect(d.fields.name).toBe(dir.split("/").pop() as string);
  });
});

describe("listRepoRows", () => {
  test("projects first, then orca, then session; deduped by realpath", async () => {
    const dir = tempDir();
    const real = join(dir, "repo-a");
    const link = join(dir, "link-a");
    mkdirSync(real);
    symlinkSync(real, link);

    const { run } = fakeRun((call) => {
      const { command, args } = call;
      if (command === "orca" && args[0] === "repo" && args[1] === "list")
        return ok(
          JSON.stringify({
            repos: [
              { path: link, displayName: "From Orca", worktreeBaseRef: "origin/dev", worktreeBasePath: "/wt" },
              { path: join(dir, "orca-only"), displayName: "Orca Only" },
            ],
          }),
        );
      return fail(127);
    });

    const rows = await listRepoRows(
      run,
      [{ repo: real, name: "Project A", base: "main", worktreeRoot: undefined }],
      [link, join(dir, "recent-one")],
    );
    // One row per realpath: the project row wins, picks up orca's worktreeRoot.
    const a = rows.find((r) => r.path === real);
    expect(a).toBeDefined();
    expect(a!.source).toBe("project");
    expect(a!.worktreeRoot).toBe("/wt");
    // The symlinked orca/session entries collapsed into the project row.
    expect(rows.filter((r) => r.path === link || r.path === real).length).toBe(1);
    expect(rows.some((r) => r.path === join(dir, "orca-only"))).toBe(true);
    expect(rows.some((r) => r.path === join(dir, "recent-one"))).toBe(true);
  });

  test("a missing orca CLI just yields fewer rows, never an error", async () => {
    const dir = tempDir();
    const { run } = fakeRun(() => fail(127, "command not found: orca"));
    const rows = await listRepoRows(run, [{ repo: dir, name: "Mine", base: "main" }], []);
    expect(rows).toEqual([{ path: dir, name: "Mine", source: "project", base: "main" }]);
  });

  test("orcaRepos returns null on CLI failure and filters malformed rows", async () => {
    const { run: dead } = fakeRun(() => fail(127));
    expect(await orcaRepos(dead)).toBeNull();
    const { run } = fakeRun(() =>
      ok(
        JSON.stringify({
          repos: [
            { path: "/a", displayName: "A" },
            { displayName: "no-path" },
            "garbage",
            { path: "/b", worktreeBaseRef: 42 },
            { path: "/c", worktreeBasePath: "/wt/c" },
          ],
        }),
      ),
    );
    expect(await orcaRepos(run)).toEqual([
      { path: "/a", displayName: "A" },
      { path: "/c", worktreeBasePath: "/wt/c" },
    ]);
  });
});

describe("recent-repos store", () => {
  test("records most-recent-first, dedupes by realpath, caps at 5", async () => {
    const home = tempDir();
    const a = join(home, "a");
    const b = join(home, "b");
    mkdirSync(a);
    mkdirSync(b);
    await recordRecentRepo(home, a);
    await recordRecentRepo(home, b);
    await recordRecentRepo(home, a);
    expect(await readRecentRepos(home)).toEqual([a, b]);
    for (let i = 0; i < 6; i++) {
      const d = join(home, `r${i}`);
      mkdirSync(d);
      await recordRecentRepo(home, d);
    }
    const recent = await readRecentRepos(home);
    expect(recent.length).toBe(5);
    expect(recent[0]).toBe(join(home, "r5"));
  });

  test("corrupt or missing file reads as empty", async () => {
    const home = tempDir();
    expect(await readRecentRepos(home)).toEqual([]);
    await Bun.write(join(home, "recent-repos.json"), "not json");
    expect(await readRecentRepos(home)).toEqual([]);
  });
});
