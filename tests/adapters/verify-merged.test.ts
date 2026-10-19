import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { githubPrDelivery } from "../../src/adapters/delivery-github-pr.ts";
import { localMergeDelivery } from "../../src/adapters/delivery-local-merge.ts";
import { noneDelivery } from "../../src/adapters/delivery-none.ts";
import type { Contact, Operation } from "../../src/core/types.ts";
import type { CommandResult, Run } from "../../src/ports.ts";
import { contact, lane, removeAll, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const realRun: Run = async (command, args, cwd) => {
  const p = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
};
const git = async (cwd: string, ...args: string[]) => {
  const out = await realRun("git", args, cwd);
  if (out.code !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
};

/** A repo on `main` with one commit and an `origin` remote that has `main` pushed. */
async function repoWithRemote() {
  const root = tempDir("merged", dirs);
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  await realRun("git", ["init", "-q", "--bare", "-b", "main", remote], root);
  await realRun("git", ["init", "-q", "-b", "main", repo], root);
  writeFileSync(join(repo, "f.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-q", "origin", "main");
  const branch = async (name: string, file: string) => {
    await git(repo, "checkout", "-qb", name, "main");
    writeFileSync(join(repo, file), `${name}\n`);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", name);
    await git(repo, "push", "-q", "origin", name);
    await git(repo, "checkout", "-q", "main");
  };
  return { repo, branch };
}

const operation = (repo: string, delivery: Operation["delivery"]): Operation =>
  ({ v: 1, id: "lab", name: "Lab", repo, base: "main", integration: repo, delivery } as Operation);
const target = (branch: string): Contact => contact("a", { lane: lane("/wt/a", "t1", branch) });

/** git is real; gh answers the PR lookup from a table keyed by branch. */
function withGh(answer: (branch: string) => CommandResult): Run {
  return async (command, args, cwd) => (command === "gh" ? answer(args[2] ?? "") : realRun(command, args, cwd));
}
const pr = (state: string, extra: Record<string, unknown> = {}): CommandResult => ({
  stdout: JSON.stringify({ state, baseRefName: "main", number: 242, url: "https://github.com/x/pull/242", ...extra }),
  stderr: "",
  code: 0,
});

test("a branch with commits outside the base is not merged, and says how many", async () => {
  const { repo, branch } = await repoWithRemote();
  await branch("feat/a", "a.txt");
  const verdict = await noneDelivery(realRun).verifyMerged({ operation: operation(repo, "none"), contact: target("feat/a"), branch: "feat/a" });
  expect(verdict).toEqual({ merged: false, reason: "1 commit on feat/a not in main" });
});

test("a fast-forward merge counts, and so does a rebase that rewrote the commit", async () => {
  const { repo, branch } = await repoWithRemote();
  await branch("feat/ff", "ff.txt");
  await git(repo, "merge", "-q", "--ff-only", "feat/ff");
  await git(repo, "push", "-q", "origin", "main");
  const ff = await noneDelivery(realRun).verifyMerged({ operation: operation(repo, "none"), contact: target("feat/ff"), branch: "feat/ff" });
  expect(ff.merged).toBe(true);

  await branch("feat/rb", "rb.txt");
  await git(repo, "cherry-pick", "feat/rb");
  await git(repo, "push", "-q", "origin", "main");
  const rebased = await noneDelivery(realRun).verifyMerged({ operation: operation(repo, "none"), contact: target("feat/rb"), branch: "feat/rb" });
  expect(rebased.merged).toBe(true);
});

test("a branch that exists nowhere cannot be verified, so it is refused", async () => {
  const { repo } = await repoWithRemote();
  const verdict = await noneDelivery(realRun).verifyMerged({ operation: operation(repo, "none"), contact: target("gone"), branch: "gone" });
  expect(verdict.merged).toBe(false);
});

test("local-merge reads the local base, which was never pushed", async () => {
  const { repo, branch } = await repoWithRemote();
  await branch("feat/l", "l.txt");
  await git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feat/l");
  const local = await localMergeDelivery(realRun).verifyMerged({ operation: operation(repo, "local-merge"), contact: target("feat/l"), branch: "feat/l" });
  expect(local.merged).toBe(true);
  const remoteOnly = await noneDelivery(realRun).verifyMerged({ operation: operation(repo, "none"), contact: target("feat/l"), branch: "feat/l" });
  expect(remoteOnly.merged).toBe(false);
});

test("github-pr trusts a merged PR even though a squash left the branch commits outside the base", async () => {
  const { repo, branch } = await repoWithRemote();
  await branch("feat/sq", "sq.txt");
  const delivery = githubPrDelivery(withGh(() => pr("MERGED")));
  expect(await delivery.verifyMerged({ operation: operation(repo, "github-pr"), contact: target("feat/sq"), branch: "feat/sq" })).toEqual({
    merged: true,
    detail: "PR #242 merged into main",
  });
});

test("github-pr refuses an open PR and names it, and a PR merged into another branch", async () => {
  const { repo, branch } = await repoWithRemote();
  await branch("feat/o", "o.txt");
  const open = await githubPrDelivery(withGh(() => pr("OPEN"))).verifyMerged({ operation: operation(repo, "github-pr"), contact: target("feat/o"), branch: "feat/o" });
  expect(open).toEqual({ merged: false, reason: "PR #242 is still open; 1 commit on feat/o not in main" });
  const wrongBase = await githubPrDelivery(withGh(() => pr("MERGED", { baseRefName: "release" }))).verifyMerged({ operation: operation(repo, "github-pr"), contact: target("feat/o"), branch: "feat/o" });
  expect(wrongBase).toEqual({ merged: false, reason: "PR #242 merged into release, not main" });
});

test("github-pr falls back to git when gh has no answer, and a closed PR never counts", async () => {
  const { repo, branch } = await repoWithRemote();
  await branch("feat/f", "f.txt");
  const offline = githubPrDelivery(withGh(() => ({ stdout: "", stderr: "gh: not authenticated", code: 1 })));
  expect((await offline.verifyMerged({ operation: operation(repo, "github-pr"), contact: target("feat/f"), branch: "feat/f" })).merged).toBe(false);
  const closed = await githubPrDelivery(withGh(() => pr("CLOSED"))).verifyMerged({ operation: operation(repo, "github-pr"), contact: target("feat/f"), branch: "feat/f" });
  expect(closed).toEqual({ merged: false, reason: "PR #242 was closed without merging; 1 commit on feat/f not in main" });
});

test("an older merged PR cannot mark the delivered open repair PR as landed", async () => {
  const { repo, branch } = await repoWithRemote();
  await branch("feat/repair", "repair.txt");
  const url = "https://github.com/x/pull/275";
  const delivery = githubPrDelivery(withGh(selector => selector === url ? pr("OPEN", { number: 275, url }) : pr("MERGED")));
  const verdict = await delivery.verifyMerged({ operation: operation(repo, "github-pr"), contact: target("feat/repair"), branch: "feat/repair", url });
  expect(verdict).toEqual({ merged: false, reason: "PR #275 is still open; 1 commit on feat/repair not in main" });
});
