import type { CommandResult, Run } from "../ports.ts";

// `git status` for deletion/cleanup decisions. A status that cannot be read is "unknown" —
// callers must warn/skip, never treat it as clean.

export interface WorktreeStatus {
  /** "gone" → the path is not a git worktree; "unknown" → status could not be read. */
  state: "clean" | "dirty" | "gone" | "unknown";
  /** Tracked-change entries (any XY pair that is not ?? or !!). */
  tracked: number;
  /** Untracked entries (??). */
  untracked: number;
  /** Ignored entries (!!; only when git supports --ignored). */
  ignored: number;
  /** First few raw paths, for dialogs/events; bounded. */
  sample: string[];
  /** stderr detail when state is "unknown"/"gone". */
  detail?: string;
}

const SAMPLE_LIMIT = 8;
const GIT_STATUS_ARGS = ["-c", "core.quotePath=false", "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "-z"];

export async function worktreeStatus(run: Run, worktree: string): Promise<WorktreeStatus> {
  const result: CommandResult = await run("git", GIT_STATUS_ARGS, worktree).catch((error) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
    code: 1,
  }));
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `git status exit ${result.code}`;
    const gone = /not a git|No such file|cannot change to|does not exist/i.test(result.stderr);
    return { state: gone ? "gone" : "unknown", tracked: 0, untracked: 0, ignored: 0, sample: [], detail };
  }
  let tracked = 0;
  let untracked = 0;
  let ignored = 0;
  const sample: string[] = [];
  // -z entries are NUL-terminated "XY path" pairs (renames/copies carry a second path field).
  for (const entry of result.stdout.split("\0")) {
    if (entry.length < 3) continue;
    const xy = entry.slice(0, 2);
    const rawPath = entry.slice(3);
    // A rename/copy's path field is "from -> to" in v1 -z.
    const path = rawPath.includes(" -> ") ? rawPath.slice(rawPath.indexOf(" -> ") + 4) : rawPath;
    if (xy === "??") untracked += 1;
    else if (xy === "!!") ignored += 1;
    else tracked += 1;
    if (sample.length < SAMPLE_LIMIT && path) sample.push(`${xy} ${path}`);
  }
  const state = tracked + untracked + ignored === 0 ? "clean" : "dirty";
  return { state, tracked, untracked, ignored, sample };
}

/** One-line summary for events/errors, e.g. "2 tracked, 3 untracked, 12 ignored (a.ts, out/, …)". */
export function describeStatus(s: WorktreeStatus): string {
  const parts = [
    s.tracked ? `${s.tracked} tracked` : null,
    s.untracked ? `${s.untracked} untracked` : null,
    s.ignored ? `${s.ignored} ignored` : null,
  ].filter(Boolean);
  const head = parts.length ? parts.join(", ") : "clean";
  return s.sample.length ? `${head} (${s.sample.join(", ")}…)` : head;
}
