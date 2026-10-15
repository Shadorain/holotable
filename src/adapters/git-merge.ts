import { PortError, type LandResult, type MergeVerdict, type Run } from "../ports.ts";

export type MergeOutcome =
  | { outcome: "clean" }
  | Extract<LandResult, { outcome: "conflict" }>;

const git = (run: Run, args: string[], cwd: string) => run("git", args, cwd);

async function mustGit(
  run: Run,
  args: string[],
  cwd: string,
  code: string,
): Promise<string> {
  const r = await git(run, args, cwd);
  if (r.code !== 0)
    throw new PortError(code, r.stderr.trim() || `git ${args.join(" ")} failed`);
  return r.stdout.trim();
}

/**
 * Refuse to touch the integration checkout when it is on another branch, or when a tracked or
 * untracked local change overlaps a path `sourceBranch` would write. Unrelated dirty paths are
 * kept: git itself merges over them, so an operator's notes or local config do not block landing.
 */
export async function assertIntegrationReady(
  run: Run,
  integration: string,
  base: string,
  sourceBranch: string,
): Promise<void> {
  const head = await mustGit(
    run,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    integration,
    "integration-unreadable",
  );
  if (head !== base)
    throw new PortError(
      "integration-wrong-branch",
      `integration is on ${head}, expected ${base}`,
    );
  const status = await git(run, ["status", "--porcelain", "-z"], integration);
  if (status.code !== 0)
    throw new PortError(
      "integration-unreadable",
      status.stderr.trim() || "git status failed",
    );
  if (status.stdout.length === 0) return;

  const dirty = new Set<string>();
  const records = status.stdout.split("\0").filter((r) => r.length > 0);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.includes("R") || record.includes("C")) i += 1;
    dirty.add(record.slice(3));
  }

  // The result tree of a hypothetical merge names exactly the paths git would write.
  const merged = await git(run, ["merge-tree", "--write-tree", "-z", "--name-only", base, sourceBranch], integration);
  if (merged.code !== 0 && merged.code !== 1)
    throw new PortError(
      "integration-unreadable",
      merged.stderr.trim() || "git merge-tree failed",
    );
  const tree = merged.stdout.split("\0")[0]?.trim() ?? "";
  const written = await mustGit(
    run,
    ["diff", "--name-only", "-z", base, tree],
    integration,
    "integration-unreadable",
  );
  const overlapping = written
    .split("\0")
    .filter((p) => p.length > 0 && dirty.has(p));
  if (overlapping.length > 0)
    throw new PortError(
      "integration-dirty",
      `integration worktree has uncommitted changes the merge would overwrite: ${overlapping.join(", ")}`,
    );
}

async function conflictPaths(run: Run, cwd: string): Promise<string[]> {
  const r = await git(run, ["diff", "--name-only", "--diff-filter=U"], cwd);
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const abortMerge = (run: Run, cwd: string) =>
  git(run, ["merge", "--abort"], cwd);

/**
 * Committing merge used by local-merge. On conflict the integration worktree
 * is always restored (`merge --abort`) before returning.
 */
export async function mergeBranch(
  run: Run,
  integration: string,
  branch: string,
): Promise<MergeOutcome> {
  const baseSha = await mustGit(
    run,
    ["rev-parse", "HEAD"],
    integration,
    "integration-unreadable",
  );
  const deliveredSha = await mustGit(
    run,
    ["rev-parse", branch],
    integration,
    "merge-failed",
  );
  const m = await git(
    run,
    ["merge", "--no-ff", "--no-edit", branch],
    integration,
  );
  if (m.code === 0) return { outcome: "clean" };
  const paths = await conflictPaths(run, integration);
  await abortMerge(run, integration);
  if (paths.length === 0)
    throw new PortError(
      "merge-failed",
      m.stderr.trim() || `git merge ${branch} failed`,
    );
  return { outcome: "conflict", paths, deliveredSha, baseSha };
}

/**
 * Throwaway merge used to test PR mergeability: `--no-commit`, and the result
 * is always aborted so integration stays clean either way. Caller supplies the
 * delivered sha (for github-pr this is the fetched PR head).
 */
export async function probeMerge(
  run: Run,
  integration: string,
  ref: string,
): Promise<
  | { outcome: "clean" }
  | { outcome: "conflict"; paths: string[]; baseSha: string }
> {
  const baseSha = await mustGit(
    run,
    ["rev-parse", "HEAD"],
    integration,
    "integration-unreadable",
  );
  const m = await git(
    run,
    ["merge", "--no-commit", "--no-ff", ref],
    integration,
  );
  if (m.code === 0) {
    await abortMerge(run, integration);
    return { outcome: "clean" };
  }
  const paths = await conflictPaths(run, integration);
  await abortMerge(run, integration);
  if (paths.length === 0)
    throw new PortError(
      "merge-failed",
      m.stderr.trim() || `git merge ${ref} failed`,
    );
  return { outcome: "conflict", paths, baseSha };
}

/**
 * Whether every commit of `branch` already sits in `base`: an ancestor, or patch-equivalent (rebase merge).
 * Squash merges rewrite the commits, so a PR lookup must answer those; this is the answer without one.
 * `preferLocalBase` is for local-merge, which never pushes: its base only exists locally.
 */
export async function branchInBase(
  run: Run,
  repo: string,
  base: string,
  branch: string,
  preferLocalBase = false,
): Promise<MergeVerdict> {
  // Best effort: a stale remote-tracking ref must not report an already-merged branch as unmerged.
  await git(run, ["fetch", "--quiet", "origin", base, branch], repo).catch(() => undefined);
  const resolve = async (candidates: string[]): Promise<string | null> => {
    for (const candidate of candidates) {
      const r = await git(run, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], repo);
      if (r.code === 0) return candidate;
    }
    return null;
  };
  const baseRef = await resolve(preferLocalBase ? [base, `origin/${base}`] : [`origin/${base}`, base]);
  if (!baseRef) return { merged: false, reason: `base ${base} not found in ${repo}` };
  const ref = await resolve([`origin/${branch}`, branch]);
  if (!ref) return { merged: false, reason: `branch ${branch} not found, so its merge cannot be verified` };
  const ahead = await git(run, ["rev-list", "--count", `${baseRef}..${ref}`], repo);
  if (ahead.code !== 0) return { merged: false, reason: ahead.stderr.trim() || `git rev-list ${baseRef}..${ref} failed` };
  if (Number(ahead.stdout.trim()) === 0) return { merged: true, detail: `${branch} is contained in ${base}` };
  const cherry = await git(run, ["cherry", baseRef, ref], repo);
  if (cherry.code !== 0) return { merged: false, reason: cherry.stderr.trim() || `git cherry ${baseRef} ${ref} failed` };
  const missing = cherry.stdout.split("\n").filter((line) => line.startsWith("+")).length;
  if (missing === 0) return { merged: true, detail: `${branch}'s changes are all in ${base}` };
  return { merged: false, reason: `${missing} commit${missing === 1 ? "" : "s"} on ${branch} not in ${base}` };
}
