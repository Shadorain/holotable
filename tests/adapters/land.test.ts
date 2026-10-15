import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubPrDelivery } from "../../src/adapters/delivery-github-pr.ts";
import { localMergeDelivery } from "../../src/adapters/delivery-local-merge.ts";
import type { Contact, ContactStatus, Operation } from "../../src/core/types.ts";
import type { CommandResult, Run } from "../../src/ports.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holotable-land-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

type Call = { command: string; args: string[]; cwd: string };

/** Real git spawn, injectable gh responses. */
function realRun(gh?: (args: string[]) => CommandResult): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === "gh" && gh) return gh(args);
    const proc = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, code: await proc.exited };
  };
  return { run, calls };
}

const git = async (run: Run, cwd: string, ...args: string[]): Promise<CommandResult> =>
  run("git", args, cwd);

async function makeRepo(run: Run): Promise<string> {
  const dir = tempDir();
  await git(run, dir, "init", "-q", "-b", "main");
  await git(run, dir, "config", "user.email", "t@t");
  await git(run, dir, "config", "user.name", "t");
  writeFileSync(join(dir, "f.txt"), "base\n");
  await git(run, dir, "add", "-A");
  await git(run, dir, "commit", "-qm", "init");
  return dir;
}

async function branchWith(run: Run, repo: string, branch: string, content: string) {
  await git(run, repo, "checkout", "-qb", branch, "main");
  writeFileSync(join(repo, "f.txt"), content);
  await git(run, repo, "commit", "-qam", `change on ${branch}`);
  await git(run, repo, "checkout", "-q", "main");
}

function makeOperation(integration: string): Operation {
  return {
    v: 1,
    id: "demo",
    name: "Demo",
    repo: integration,
    integration,
    base: "main",
    pause: false,
    tracker: "github",
    fleet: "omp-mission",
    frontend: "orca",
    delivery: "local-merge",
    zones: [],
    contacts: [],
    project: null,
    recover: false,
    createdAt: "2026-10-09T00:00:00.000Z",
  };
}

const contact: Contact = {
  ticket: "acme/w#1",
  title: null,
  zone: "ops",
  kind: "implement",
  blockedBy: [],
  conflictOf: null,
  lane: { worktree: "/wt", branch: "feat", frontend: "orca", terminal: null },
};
const status = { delivery: { url: null, branch: "feat" } } as ContactStatus;

describe("localMergeDelivery.land", () => {
  test("clean merge lands and stays on base", async () => {
    const { run } = realRun();
    const repo = await makeRepo(run);
    await branchWith(run, repo, "feat", "base\nfeat\n");
    const result = await localMergeDelivery(run).land({
      operation: makeOperation(repo),
      contact,
      sourceBranch: "feat",
      status,
    });
    expect(result).toEqual({ outcome: "landed", via: "merge" });
    const head = await git(run, repo, "rev-parse", "--abbrev-ref", "HEAD");
    expect(head.stdout.trim()).toBe("main");
    const merged = await git(run, repo, "merge-base", "--is-ancestor", "feat", "main");
    expect(merged.code).toBe(0);
  });

  test("conflict returns paths and shas, leaves integration clean", async () => {
    const { run } = realRun();
    const repo = await makeRepo(run);
    await branchWith(run, repo, "feat", "conflicting\n");
    writeFileSync(join(repo, "f.txt"), "ours\n");
    await git(run, repo, "commit", "-qam", "ours");
    const baseSha = (await git(run, repo, "rev-parse", "HEAD")).stdout.trim();
    const deliveredSha = (await git(run, repo, "rev-parse", "feat")).stdout.trim();
    const result = await localMergeDelivery(run).land({
      operation: makeOperation(repo),
      contact,
      sourceBranch: "feat",
      status,
    });
    expect(result).toEqual({
      outcome: "conflict",
      paths: ["f.txt"],
      deliveredSha,
      baseSha,
    });
    const dirty = await git(run, repo, "status", "--porcelain");
    expect(dirty.stdout.trim()).toBe("");
    const head = await git(run, repo, "rev-parse", "--abbrev-ref", "HEAD");
    expect(head.stdout.trim()).toBe("main");
  });

  test("refuses when local changes overlap paths the merge writes", async () => {
    const { run, calls } = realRun();
    const repo = await makeRepo(run);
    await branchWith(run, repo, "feat", "base\nfeat\n");
    writeFileSync(join(repo, "f.txt"), "uncommitted\n");
    await expect(
      localMergeDelivery(run).land({
        operation: makeOperation(repo),
        contact,
        sourceBranch: "feat",
        status,
      }),
    ).rejects.toMatchObject({ code: "integration-dirty", message: expect.stringContaining("f.txt") });
    expect(calls.some((c) => c.args[0] === "merge")).toBe(false);
  });

  test("unrelated uncommitted files do not block the merge and are preserved", async () => {
    const { run } = realRun();
    const repo = await makeRepo(run);
    await branchWith(run, repo, "feat", "base\nfeat\n");
    writeFileSync(join(repo, "notes.md"), "operator notes\n");
    const result = await localMergeDelivery(run).land({
      operation: makeOperation(repo),
      contact,
      sourceBranch: "feat",
      status,
    });
    expect(result).toEqual({ outcome: "landed", via: "merge" });
    const dirty = await git(run, repo, "status", "--porcelain");
    expect(dirty.stdout.trim()).toBe("?? notes.md");
    expect((await git(run, repo, "log", "-1", "--format=%s")).stdout.trim()).toContain("feat");
  });

  test("untracked file in the merge's way blocks, like git merge", async () => {
    const { run, calls } = realRun();
    const repo = await makeRepo(run);
    await branchWith(run, repo, "feat", "base\nfeat\n");
    await git(run, repo, "checkout", "-qb", "feat2");
    writeFileSync(join(repo, "added.txt"), "from branch\n");
    await git(run, repo, "add", "added.txt");
    await git(run, repo, "commit", "-qm", "add file");
    await git(run, repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "added.txt"), "local untracked\n");
    await expect(
      localMergeDelivery(run).land({
        operation: makeOperation(repo),
        contact,
        sourceBranch: "feat2",
        status,
      }),
    ).rejects.toMatchObject({ code: "integration-dirty", message: expect.stringContaining("added.txt") });
    expect(calls.some((c) => c.args[0] === "merge")).toBe(false);
  });

  test("refuses wrong-branch integration", async () => {
    const { run } = realRun();
    const repo = await makeRepo(run);
    await branchWith(run, repo, "feat", "base\nfeat\n");
    await git(run, repo, "checkout", "-qb", "other");
    await expect(
      localMergeDelivery(run).land({
        operation: makeOperation(repo),
        contact,
        sourceBranch: "feat",
        status,
      }),
    ).rejects.toMatchObject({ code: "integration-wrong-branch" });
    const dirty = await git(run, repo, "status", "--porcelain");
    expect(dirty.stdout.trim()).toBe("");
  });
});

describe("githubPrDelivery.land", () => {
  const prJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      state: "OPEN",
      mergeable: "MERGEABLE",
      baseRefName: "main",
      headRefName: "feat",
      headRefOid: "deadbeef",
      url: "https://github.com/acme/w/pull/7",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      ...over,
    });

  async function prSetup(run: Run): Promise<{ repo: string; remote: string }> {
    const remote = join(tempDir(), "origin.git");
    await git(run, tempDir(), "init", "-q", "--bare", remote);
    const repo = await makeRepo(run);
    await git(run, repo, "remote", "add", "origin", remote);
    await branchWith(run, repo, "feat", "base\nfeat\n");
    await git(run, repo, "push", "-q", "origin", "main", "feat");
    const featSha = (await git(run, repo, "rev-parse", "feat")).stdout.trim();
    // Bare remote accepts arbitrary refs; stand in for GitHub's refs/pull.
    await git(run, remote, "update-ref", "refs/pull/7/head", featSha);
    return { repo, remote };
  }

  test("clean path merges the PR exactly once and returns landed/pr", async () => {
    const ghCalls: string[][] = [];
    const { run } = realRun((args) => {
      ghCalls.push(args);
      if (args[1] === "view") return { stdout: prJson(), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });
    const { repo } = await prSetup(run);
    const result = await githubPrDelivery(run).land({
      operation: makeOperation(repo),
      contact,
      sourceBranch: "feat",
      status,
    });
    expect(result).toEqual({ outcome: "landed", via: "pr" });
    const merges = ghCalls.filter((a) => a[1] === "merge");
    expect(merges).toEqual([["pr", "merge", "7", "--merge"]]);
    const dirty = await git(run, repo, "status", "--porcelain");
    expect(dirty.stdout.trim()).toBe("");
  });

  test("squash-only repo merges with --squash", async () => {
    const ghCalls: string[][] = [];
    const { run } = realRun((args) => {
      ghCalls.push(args);
      if (args[0] === "pr" && args[1] === "view") return { stdout: prJson(), stderr: "", code: 0 };
      if (args[0] === "repo") return { stdout: JSON.stringify({ mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false }), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });
    const { repo } = await prSetup(run);
    const result = await githubPrDelivery(run).land({
      operation: makeOperation(repo),
      contact,
      sourceBranch: "feat",
      status,
    });
    expect(result).toEqual({ outcome: "landed", via: "pr" });
    expect(ghCalls.filter((a) => a[1] === "merge")).toEqual([["pr", "merge", "7", "--squash"]]);
  });

  test("pr-base-mismatch refuses before any merge", async () => {
    const calls: Call[] = [];
    const { run } = realRun((args) => {
      if (args[1] === "view")
        return { stdout: prJson({ baseRefName: "release" }), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });
    const { repo } = await prSetup(run);
    const wrapped: Run = async (c, a, w) => {
      calls.push({ command: c, args: a, cwd: w });
      return run(c, a, w);
    };
    await expect(
      githubPrDelivery(wrapped).land({
        operation: makeOperation(repo),
        contact,
        sourceBranch: "feat",
        status,
      }),
    ).rejects.toMatchObject({ code: "pr-base-mismatch" });
    expect(calls.some((c) => c.args[0] === "merge")).toBe(false);
  });

  test("checks-failing refuses without side effects", async () => {
    const ghCalls: string[][] = [];
    const { run } = realRun((args) => {
      ghCalls.push(args);
      return {
        stdout: prJson({
          statusCheckRollup: [{ name: "Lint", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "Verify policy change explanation", status: "COMPLETED", conclusion: "FAILURE" }],
        }),
        stderr: "",
        code: 0,
      };
    });
    const { repo } = await prSetup(run);
    await expect(
      githubPrDelivery(run).land({
        operation: makeOperation(repo),
        contact,
        sourceBranch: "feat",
        status,
      }),
    ).rejects.toMatchObject({ code: "checks-failing", message: "failing check: Verify policy change explanation" });
    expect(ghCalls.some((a) => a[1] === "merge")).toBe(false);
  });

  test("conflict path: no gh pr merge, integration clean, shas returned", async () => {
    const ghCalls: string[][] = [];
    const { run } = realRun((args) => {
      ghCalls.push(args);
      return { stdout: prJson(), stderr: "", code: 0 };
    });
    const { repo } = await prSetup(run);
    // Make remote feat conflict with main.
    await git(run, repo, "checkout", "-qb", "conflict-branch", "feat");
    writeFileSync(join(repo, "f.txt"), "conflict\n");
    await git(run, repo, "commit", "-qam", "conflict");
    const conflictSha = (await git(run, repo, "rev-parse", "HEAD")).stdout.trim();
    await git(run, repo, "push", "-q", "origin", "conflict-branch:feat", "conflict-branch:refs/pull/7/head");
    await git(run, repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "f.txt"), "ours\n");
    await git(run, repo, "commit", "-qam", "ours");
    const baseSha = (await git(run, repo, "rev-parse", "HEAD")).stdout.trim();
    const result = await githubPrDelivery(run).land({
      operation: makeOperation(repo),
      contact,
      sourceBranch: "feat",
      status,
    });
    expect(result).toMatchObject({ outcome: "conflict", paths: ["f.txt"], baseSha });
    if (result.outcome === "conflict") expect(result.deliveredSha).toBe(conflictSha);
    expect(ghCalls.some((a) => a[1] === "merge")).toBe(false);
    const dirty = await git(run, repo, "status", "--porcelain");
    expect(dirty.stdout.trim()).toBe("");
  });

  test("resolution branch pushes to headRefName without force", async () => {
    const calls: Call[] = [];
    const { run: base0 } = realRun((args) => {
      if (args[1] === "view") return { stdout: prJson(), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });
    const run: Run = async (c, a, w) => {
      calls.push({ command: c, args: a, cwd: w });
      return base0(c, a, w);
    };
    const { repo, remote } = await prSetup(run);
    await git(run, repo, "checkout", "-qb", "resolve-1", "feat");
    writeFileSync(join(repo, "f.txt"), "resolved\n");
    await git(run, repo, "commit", "-qam", "resolve");
    await git(run, repo, "checkout", "-q", "main");
    // Remote refs/pull/7/head sees the pushed head like GitHub would.
    await git(run, repo, "push", "-q", "-f", "origin", "resolve-1:refs/pull/7/head");
    const result = await githubPrDelivery(run).land({
      operation: makeOperation(repo),
      contact,
      sourceBranch: "resolve-1",
      status,
    });
    expect(result).toEqual({ outcome: "landed", via: "pr" });
    const pushes = calls.filter(
      (c) => c.command === "git" && c.args[0] === "push" && c.cwd === repo && !c.args.includes("-f"),
    );
    const landPush = pushes.find((c) => c.args.includes("resolve-1:feat"));
    expect(landPush?.args).toEqual(["push", "origin", "resolve-1:feat"]);
    expect(landPush?.args).not.toContain("--force");
  });

  test("push rejection surfaces as push-rejected", async () => {
    const { run } = realRun((args) => {
      if (args[1] === "view") return { stdout: prJson(), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });
    const { repo, remote } = await prSetup(run);
    // Remote feat has a commit resolve-1 does not contain: non-fast-forward.
    await git(run, repo, "checkout", "-qb", "remote-advanced", "main");
    writeFileSync(join(repo, "other.txt"), "new\n");
    await git(run, repo, "add", "other.txt");
    await git(run, repo, "commit", "-qam", "advance");
    await git(run, repo, "push", "-q", "origin", "remote-advanced");
    const advSha = (await git(run, repo, "rev-parse", "remote-advanced")).stdout.trim();
    await git(run, remote, "update-ref", "refs/heads/feat", advSha);
    await git(run, repo, "checkout", "-qb", "resolve-1", "main");
    writeFileSync(join(repo, "f.txt"), "resolved\n");
    await git(run, repo, "commit", "-qam", "resolve");
    await git(run, repo, "checkout", "-q", "main");
    await expect(
      githubPrDelivery(run).land({
        operation: makeOperation(repo),
        contact,
        sourceBranch: "resolve-1",
        status,
      }),
    ).rejects.toMatchObject({ code: "push-rejected" });
  });
});
