import { PortError, type LandResult, type Run } from "../ports.ts";

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

/** Refuse to touch the integration worktree unless clean and on `base`. */
export async function assertIntegrationReady(
  run: Run,
  integration: string,
  base: string,
): Promise<void> {
  const status = await git(run, ["status", "--porcelain"], integration);
  if (status.code !== 0)
    throw new PortError(
      "integration-unreadable",
      status.stderr.trim() || "git status failed",
    );
  if (status.stdout.trim().length > 0)
    throw new PortError(
      "integration-dirty",
      "integration worktree has uncommitted changes",
    );
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
