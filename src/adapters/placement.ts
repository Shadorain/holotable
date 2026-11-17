// Create-time resolution for explicitly placed (remote) operations and projects.
//
// Everything here runs board-side but answers host-side facts: `orca project setups --host H`
// enumerates registered project-host-setups, and `orca worktree exec` runs git probes inside them.
// Nothing touches the local filesystem — a remote path is never realpath'ed or stat'ed locally.

import { detectRepo, type DetectionResult } from "./detector.ts";
import { decode } from "./orca-envelope.ts";
import { orcaExec, parseHostSetups, remoteRun, type ExecutionHost, type HostSetup } from "./orca-exec.ts";
import { PortError, type Run } from "../ports.ts";

export interface RemotePlacementRequest {
  host: ExecutionHost;
  /** Orca project-host-setup id; wins over path/url matching. */
  hostSetup?: string;
  /** Remote checkout path (operation.repo) when the caller knows it. */
  repo?: string;
  /** Normalized origin URL of the source checkout, to map a local repo onto the host's clone. */
  remoteUrl?: string | null;
}

export interface ResolvedPlacement {
  /** The ready setup that owns the remote checkout. */
  setup: HostSetup;
  /** Remote checkout path (setup.path). */
  repo: string;
  /** A real `Run` executing argv on `host`, anchored at the resolved setup. */
  run: Run;
  /** Remote realpath: canonicalizes a path on `host`, null when it does not exist there. */
  realpath: (path: string) => Promise<string | null>;
}

/** List the host's registered project-host-setups (ready or not — the caller decides). */
export async function listHostSetups(run: Run, cwd: string, host: ExecutionHost): Promise<HostSetup[]> {
  const payload = decode(await run("orca", ["project", "setups", "--host", host, "--json"], cwd));
  return parseHostSetups(payload, host);
}

/** `git remote get-url origin` on `host` at `path` via `orca worktree exec`; null when absent. */
export async function remoteOriginUrl(
  run: Run,
  cwd: string,
  i: { host: ExecutionHost; worktree: string },
): Promise<string | null> {
  const r = await orcaExec(run, cwd, {
    host: i.host,
    worktree: i.worktree,
    argv: ["git", "remote", "get-url", "origin"],
  });
  const url = r.stdout.trim();
  return r.exitCode === 0 && url.length > 0 ? url : null;
}

/** Normalize a git remote URL for cross-host comparison (scheme/user/.git differences collapse). */
export function normalizeRemoteUrl(url: string): string | null {
  let rest: string;
  const sshScp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(url.trim());
  if (sshScp) {
    rest = `${sshScp[1]}/${sshScp[2]}`;
  } else {
    try {
      const u = new URL(url.trim());
      if (!u.hostname) return null;
      rest = `${u.hostname}${u.pathname}`;
    } catch {
      return null;
    }
  }
  rest = rest.toLowerCase().replace(/\/+$/, "");
  return rest.endsWith(".git") ? rest.slice(0, -4) : rest;
}

function requireReady(setup: HostSetup, host: ExecutionHost): HostSetup {
  if (setup.state !== null && setup.state !== "ready")
    throw new PortError("host-unprepared", `Project-host-setup ${setup.id} is "${setup.state}" on ${host}, expected "ready"`);
  return setup;
}

/**
 * Resolve the one ready setup on `host` that owns this operation's checkout.
 * Order: explicit hostSetup id → setup.path === repo → origin URL match against `remoteUrl`.
 * Zero or several matches throw a PortError naming the setups; placement is never guessed.
 */
export async function resolveRemotePlacement(
  run: Run,
  cwd: string,
  i: RemotePlacementRequest,
): Promise<ResolvedPlacement> {
  const setups = (await listHostSetups(run, cwd, i.host)).filter((s) => s.path !== null);
  let found: HostSetup | undefined;
  if (i.hostSetup !== undefined) {
    found = setups.find((s) => s.id === i.hostSetup);
    if (!found)
      throw new PortError(
        "host-setup-missing",
        `Project-host-setup ${i.hostSetup} does not exist on host ${i.host}. List them with: orca project setups --host ${i.host} --json`,
      );
    if (i.repo !== undefined && found.path !== i.repo)
      throw new PortError(
        "host-setup-mismatch",
        `Project-host-setup ${i.hostSetup} checks out ${found.path} on ${i.host}, not ${i.repo}`,
      );
  } else if (i.repo !== undefined) {
    const matches = setups.filter((s) => s.path === i.repo);
    if (matches.length === 0)
      throw new PortError(
        "host-setup-missing",
        `No Orca project-host-setup on host ${i.host} owns ${i.repo}. Create one in Orca on that host (project setup) or set hostSetup to its id.`,
      );
    if (matches.length > 1)
      throw new PortError(
        "host-setup-ambiguous",
        `${matches.length} project-host-setups on ${i.host} point at ${i.repo}; set hostSetup to one of: ${matches.map((m) => m.id).join(", ")}`,
      );
    found = matches[0];
  } else if (i.remoteUrl) {
    const want = normalizeRemoteUrl(i.remoteUrl);
    const matches: HostSetup[] = [];
    for (const s of setups) {
      if (s.state !== null && s.state !== "ready") continue;
      // A throw here is a transport/registration failure, not "no origin" — do not swallow it.
      const url = await remoteOriginUrl(run, cwd, { host: i.host, worktree: s.path! });
      if (url !== null && normalizeRemoteUrl(url) === want) matches.push(s);
    }
    if (matches.length === 0)
      throw new PortError(
        "host-setup-missing",
        `No ready project-host-setup on ${i.host} has origin ${i.remoteUrl}. Set hostSetup to an id from: orca project setups --host ${i.host} --json`,
      );
    if (matches.length > 1)
      throw new PortError(
        "host-setup-ambiguous",
        `${matches.length} project-host-setups on ${i.host} share origin ${i.remoteUrl}; set hostSetup to one of: ${matches.map((m) => m.id).join(", ")}`,
      );
    found = matches[0];
  } else {
    throw new PortError(
      "host-setup-missing",
      `Remote placement on ${i.host} needs repo (a remote checkout path), remoteUrl, or hostSetup: nothing else identifies which project clone owns the lanes.`,
    );
  }
  requireReady(found, i.host);
  const repo = found.path!;
  // worktree exec refuses anything that is not an exact registered worktree. A ready setup's path
  // is that host's main checkout, which git worktree list (and Orca's scan) registers; prove it
  // before any relay deploy. A miss is host-unprepared, never an ambient-cwd fallback.
  try {
    await orcaExec(run, cwd, { host: i.host, worktree: repo, argv: ["true"], timeoutMs: 15_000 });
  } catch (error) {
    throw new PortError(
      "host-unprepared",
      `Project-host-setup ${found.id} path ${repo} is not a registered worktree on ${i.host}, so it cannot anchor worktree exec: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const hostRun = remoteRun(run, cwd, { host: i.host, anchorWorktree: repo });
  return {
    setup: found,
    repo,
    run: hostRun,
    realpath: async (path) => {
      const r = await orcaExec(run, cwd, {
        host: i.host,
        worktree: repo,
        argv: ["sh", "-c", 'cd "$1" 2>/dev/null && pwd -P', "sh", path],
      });
      const out = r.stdout.trim();
      return r.exitCode === 0 && out.startsWith("/") ? out : null;
    },
  };
}

/**
 * `detectRepo` on a remote checkout. Git probes use the host Run; path canonicalization uses the
 * host realpath; Orca identity is the verified setup row (never `orca repo list` on the target,
 * and never a local realpath of a remote path). gh/lin/herdr stay on the board Run.
 */
export async function detectRemoteRepo(
  run: Run,
  cwd: string,
  i: RemotePlacementRequest,
): Promise<{ placement: ResolvedPlacement; detected: DetectionResult }> {
  const placement = await resolveRemotePlacement(run, cwd, i);
  const detected = await detectRepo(
    placement.repo,
    placement.run,
    [{ path: placement.repo, displayName: placement.setup.projectId || undefined }],
    {
      canonicalize: async (path) => (await placement.realpath(path)) ?? path,
      probeRun: run,
    },
  );
  return { placement, detected };
}
