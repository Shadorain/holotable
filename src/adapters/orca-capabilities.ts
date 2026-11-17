import type { Run } from "../ports.ts";
import { withTimeout } from "../timeout.ts";

const HELP_TIMEOUT_MS = 5_000;
const CACHE_MS = 10_000;
const HELP_ARGS = ["worktree", "create", "--help"];

interface CachedCapability {
  cwd: string;
  expiresAt: number;
  supported: boolean;
  detail: string;
}

const cache = new WeakMap<Run, CachedCapability>();

/** Checks the exact Orca binary behind Run; short-lived caching still observes CLI upgrades. */
export async function checkOrcaStartupCommand(run: Run, cwd: string): Promise<{ supported: boolean; detail: string }> {
  const now = Date.now();
  const cached = cache.get(run);
  if (cached && cached.cwd === cwd && cached.expiresAt > now)
    return { supported: cached.supported, detail: cached.detail };

  let supported = false;
  let detail: string;
  try {
    const result = await withTimeout(run("orca", HELP_ARGS, cwd), HELP_TIMEOUT_MS, "Orca help timed out");
    const help = `${result.stdout}\n${result.stderr}`;
    supported = result.code === 0 && /(?:^|\s)--command(?:[=\s,]|$)/m.test(help);
    detail = result.code !== 0
      ? (result.stderr.trim() || result.stdout.trim() || `Orca exited with code ${result.code}`)
      : supported ? "Supports worktree create --command" : "Orca worktree create help does not advertise --command";
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  cache.set(run, { cwd, expiresAt: now + CACHE_MS, supported, detail });
  return { supported, detail };
}
