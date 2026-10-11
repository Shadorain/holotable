import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { decode } from "./orca-envelope.ts";
import type { Run } from "../ports.ts";

export interface RepoRow {
  path: string;
  name: string;
  source: "orca" | "project" | "session";
  base?: string;
  worktreeRoot?: string;
}

export interface DetectedFields {
  name: string;
  base: string;
  integration: string;
  tracker: string;
  fleet: string;
  frontend: string;
  delivery: string;
  pause: boolean;
  worktreeRoot?: string;
}

export interface DetectionResult {
  fields: DetectedFields;
  reasons: Record<string, string>;
}

interface OrcaRepoEntry {
  displayName?: string;
  path: string;
  worktreeBaseRef?: string;
  worktreeBasePath?: string;
}

const stripOrigin = (ref: string): string => (ref.startsWith("origin/") ? ref.slice(7) : ref);

/** `orca repo list --json` via the injected Run; returns rows or null when Orca is absent or unhappy. */
export async function orcaRepos(run: Run): Promise<OrcaRepoEntry[] | null> {
  try {
    const result = decode(await run("orca", ["repo", "list", "--json"], process.cwd()));
    const rows = Array.isArray(result.repos) ? result.repos : [];
    return rows.filter((r): r is OrcaRepoEntry => {
      if (typeof r !== "object" || r === null) return false;
      if (!("path" in r) || typeof r.path !== "string") return false;
      if ("displayName" in r && r.displayName !== undefined && typeof r.displayName !== "string") return false;
      if ("worktreeBaseRef" in r && r.worktreeBaseRef !== undefined && typeof r.worktreeBaseRef !== "string") return false;
      if ("worktreeBasePath" in r && r.worktreeBasePath !== undefined && typeof r.worktreeBasePath !== "string") return false;
      return true;
    });
  } catch {
    return null;
  }
}

/** The git top-level for `path`, or null when it is not inside a git work tree. */
async function gitTopLevel(run: Run, path: string): Promise<string | null> {
  const result = await run("git", ["rev-parse", "--show-toplevel"], path);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The remote HEAD ref (e.g. `origin/main`), or null when unset. */
async function remoteHead(run: Run, repo: string): Promise<string | null> {
  const result = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The currently checked-out branch, or null on a detached head. */
async function currentBranch(run: Run, repo: string): Promise<string | null> {
  const result = await run("git", ["branch", "--show-current"], repo);
  const branch = result.code === 0 ? result.stdout.trim() : "";
  return branch.length ? branch : null;
}

/** `origin`'s URL, or null when no origin exists. */
async function remoteUrl(run: Run, repo: string): Promise<string | null> {
  const result = await run("git", ["remote", "get-url", "origin"], repo);
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Whether `url` points at GitHub (https or ssh). */
export function isGitHubRemote(url: string | null): boolean {
  if (!url) return false;
  return url.includes("github.com");
}

/**
 * Detect project fields for one repo. Runs every check through `run` so tests and the
 * playground can fake the CLIs; any missing binary or command failure degrades to
 * the next fallback, never an error.
 */
export async function detectRepo(repo: string, run: Run, orca?: OrcaRepoEntry[] | null): Promise<DetectionResult> {
  const reasons: Record<string, string> = {};

  const top = await gitTopLevel(run, repo);
  if (!top) throw new Error(`${repo} is not inside a git work tree`);

  const orcaRow = orca === undefined ? await orcaRepos(run) : orca;
  const repoReal = await realpath(top).catch(() => top);
  let orcaEntry: OrcaRepoEntry | null = null;
  if (orcaRow) {
    for (const entry of orcaRow) {
      const entryReal = await realpath(entry.path).catch(() => entry.path);
      if (entryReal === repoReal || entry.path === top || entry.path === repo) {
        orcaEntry = entry;
        break;
      }
    }
  }

  const name = orcaEntry?.displayName?.trim() || basename(top) || "project";
  reasons.name = orcaEntry?.displayName ? `Orca knows this repo as ${orcaEntry.displayName}` : "Repo folder name";

  const remote = await remoteUrl(run, top);
  const githubOrigin = isGitHubRemote(remote);
  const ghOk = githubOrigin && (await run("gh", ["auth", "status"], top)).code === 0;
  const linOk = (await run("lin", ["me", "--json"], top)).code === 0;
  const herdrOk = (await run("herdr", ["--version"], top)).code === 0;

  let frontend: DetectedFields["frontend"];
  if (orcaEntry) {
    frontend = "orca";
    reasons.frontend = "Orca knows this repo";
  } else if (herdrOk) {
    frontend = "herdr";
    reasons.frontend = "Herdr is installed";
  } else {
    frontend = "none";
    reasons.frontend = "No terminal frontend found; launching needs a terminal frontend";
  }

  let tracker: DetectedFields["tracker"];
  if (linOk) {
    tracker = "linear";
    reasons.tracker = "Linear CLI is authenticated";
  } else if (ghOk) {
    tracker = "github";
    reasons.tracker = "origin is GitHub and gh is signed in";
  } else {
    tracker = "none";
    reasons.tracker = "No tracker CLI is authenticated";
  }

  let delivery: DetectedFields["delivery"];
  if (ghOk) {
    delivery = "github-pr";
    reasons.delivery = "origin is GitHub and gh is signed in";
  } else {
    delivery = "local-merge";
    reasons.delivery = "origin is not GitHub or gh is not signed in";
  }

  let base: string;
  const remoteHeadRef = await remoteHead(run, top);
  const branch = await currentBranch(run, top);
  if (orcaEntry?.worktreeBaseRef) {
    base = stripOrigin(orcaEntry.worktreeBaseRef);
    reasons.base = "Orca worktree base ref";
  } else if (remoteHeadRef) {
    base = stripOrigin(remoteHeadRef);
    reasons.base = "Remote HEAD branch";
  } else if (branch) {
    base = branch;
    reasons.base = "Current branch";
  } else {
    base = "main";
    reasons.base = "Fallback";
  }

  const fields: DetectedFields = {
    name,
    base,
    integration: top,
    tracker,
    fleet: "omp-mission",
    frontend,
    delivery,
    pause: true,
  };
  reasons.integration = "Repo path";
  reasons.fleet = "Standard mission fleet";
  reasons.pause = "Safer default";

  return { fields, reasons };
}

/** Merge `repos` into `rows`, deduplicating by realpath. */
async function mergeRepos(rows: RepoRow[], repos: RepoRow[]): Promise<void> {
  const seen: Record<string, number> = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const real = await realpath(row.path).catch(() => row.path);
    seen[real] = i;
  }
  for (const repo of repos) {
    const real = await realpath(repo.path).catch(() => repo.path);
    const existing = seen[real];
    if (existing !== undefined) {
      // A project row stays authoritative, but an orca row can fill in its worktree root.
      const row = rows[existing];
      if (row && !row.worktreeRoot && repo.worktreeRoot) row.worktreeRoot = repo.worktreeRoot;
      continue;
    }
    seen[real] = rows.length;
    rows.push(repo);
  }
}

/** List candidate repos for the picker: projects first, then Orca, then the session's recent repos. */
export async function listRepoRows(run: Run, projects: Array<{ repo: string; name: string; base: string; worktreeRoot?: string }>, recent: string[]): Promise<RepoRow[]> {
  const rows: RepoRow[] = [];

  for (const project of projects) {
    rows.push({
      path: project.repo,
      name: project.name,
      source: "project",
      base: project.base,
      ...(project.worktreeRoot ? { worktreeRoot: project.worktreeRoot } : {}),
    });
  }

  const orca = await orcaRepos(run);
  if (orca) {
    const orcaRows: RepoRow[] = orca.map((entry) => ({
      path: entry.path,
      name: entry.displayName?.trim() || basename(entry.path),
      source: "orca",
      ...(entry.worktreeBaseRef ? { base: stripOrigin(entry.worktreeBaseRef) } : {}),
      ...(entry.worktreeBasePath ? { worktreeRoot: entry.worktreeBasePath } : {}),
    }));
    await mergeRepos(rows, orcaRows);
  }

  const sessionRows: RepoRow[] = recent.map((path) => ({
    path,
    name: basename(path),
    source: "session",
  }));
  await mergeRepos(rows, sessionRows);

  return rows;
}
