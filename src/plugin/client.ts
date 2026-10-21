import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OperationSummary } from "../board.ts";
import type { Projection } from "../core/types.ts";
import { configHome, userUnitDir } from "../paths.ts";
import { installService, UNIT_NAME, type InstallOptions, type InstallResult } from "../service.ts";
import { boardIsLocked, readBoardInfo, readToken } from "../store/board.ts";

export interface ServiceRef {
  pid: number;
  url: string;
  urls: string[];
  /** URL fragment token, from <home>/token or the url hash itself. */
  token: string;
  /** http://host:port with no path or fragment. */
  base: string;
}

/** Where the board is reachable, or null when board.json is gone/stale. */
export async function serviceRef(home: string): Promise<ServiceRef | null> {
  const info = await readBoardInfo(home);
  if (!info) return null;
  try {
    const parsed = new URL(info.url);
    const token = (await readToken(home)) ?? parsed.hash.slice(1);
    if (!token) return null;
    return { pid: info.pid, url: info.url, urls: info.urls ?? [info.url], token, base: parsed.origin };
  } catch {
    return null;
  }
}

const headers = (ref: ServiceRef) => ({ "x-holotable-token": ref.token });

/** Fetch a JSON GET from the service. Errors (down, 4xx) collapse to null: callers fall back to the store. */
async function get<T>(ref: ServiceRef, path: string): Promise<T | null> {
  try {
    const res = await fetch(`${ref.base}${path}`, { headers: headers(ref), signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface ServiceHealth {
  running: boolean;
  url: string | null;
  urls?: string[];
  pid: number | null;
}

/** Live health: board.json exists and the service answers with our token. */
export async function serviceHealth(home: string): Promise<ServiceHealth> {
  const ref = await serviceRef(home);
  if (!ref) return { running: false, url: null, pid: null };
  const running = (await get<OperationSummary[]>(ref, "/api/operations")) !== null;
  if (!running) return { running: false, url: null, pid: null };
  return { running: true, url: ref.url, urls: ref.urls, pid: ref.pid };
}

export function operations(home: string): Promise<OperationSummary[] | null> {
  return serviceRef(home).then((ref) => (ref ? get<OperationSummary[]>(ref, "/api/operations") : null));
}

export function projection(home: string, opId: string): Promise<Projection | null> {
  return serviceRef(home).then((ref) => (ref ? get<Projection>(ref, `/api/projection?op=${encodeURIComponent(opId)}`) : null));
}

interface ServiceIdentity {
  pid: number;
  instance: string;
}

/** Authenticated, instance-bound shutdown; never signal a PID from a stale discovery file. */
export async function stopService(home: string, timeoutMs = 15_000): Promise<ServiceHealth> {
  const stopped: ServiceHealth = { running: false, url: null, pid: null };
  const ref = await serviceRef(home);
  if (!ref) {
    if (await boardIsLocked(home)) throw new Error("Board is locked but not discoverable; refusing to stop an unknown owner.");
    return stopped;
  }
  const identity = await get<ServiceIdentity>(ref, "/api/service");
  if (!identity) {
    if (!await boardIsLocked(home)) return stopped;
    throw new Error("Board is not answering the shutdown API. Check board.log; an older board needs one manual service restart.");
  }
  if (identity.pid !== ref.pid) throw new Error("Board discovery is stale; refusing to stop a different process.");
  const response = await fetch(`${ref.base}/api/service/stop`, {
    method: "POST",
    headers: { ...headers(ref), origin: ref.base, "content-type": "application/json" },
    body: JSON.stringify(identity),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) {
    const body = await response.json() as { error?: string };
    throw new Error(body.error ?? `Board shutdown failed (${response.status}).`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await boardIsLocked(home)) return stopped;
    const next = await serviceRef(home);
    if (next && (next.pid !== ref.pid || next.url !== ref.url)) return serviceHealth(home);
    await Bun.sleep(100);
  }
  throw new Error("Board is still finishing in-flight work; its ownership lock remains held. Retry status before restarting.");
}

export interface EnsureServiceOptions {
  home: string;
  checkHealth?(home: string): Promise<ServiceHealth>;
  platform?: string;
  hasSystemdUser?(): Promise<boolean>;
  installService?(opts: InstallOptions, enableNow: boolean): Promise<InstallResult>;
  startSystemdUnit?(opts: InstallOptions): Promise<void>;
  spawnDetached?(command: string, args: string[], logPath: string, env: Record<string, string | undefined>): Promise<void> | void;
  bunPath?: string;
  scriptPath?: string;
  configDir?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

/**
 * Ensures the board service is running and healthy. If already answering, returns immediately.
 * Otherwise starts it (via systemd user unit on Linux if available, or detached bun spawn),
 * and polls up to ~8s for health.
 */
export async function ensureService(options: string | EnsureServiceOptions): Promise<ServiceHealth> {
  const opts = typeof options === "string" ? { home: options } : options;
  const home = opts.home;
  const checkHealth = opts.checkHealth ?? serviceHealth;

  const initial = await checkHealth(home);
  if (initial.running) return initial;

  const currentPlatform = opts.platform ?? osPlatform();
  const defaultScriptPath = fileURLToPath(new URL("../../bin/holotable.ts", import.meta.url));
  const scriptPath = opts.scriptPath ?? defaultScriptPath;
  // In a compiled OMP host, execPath is OMP itself, not the Bun interpreter.
  const bunPath = opts.bunPath ?? Bun.which("bun");
  if (!bunPath) throw new Error("Holotable needs Bun on PATH to start its board. Install it from https://bun.sh.");

  // The systemd unit is "the" board: only the default home gets it. Any other home (a second board,
  // a demo, a test) runs as a plain detached process and never touches the user's units.
  const defaultHome = home === join(homedir(), ".omp", "agent", "holotable");
  let useSystemd = false;
  if (defaultHome) {
    if (opts.hasSystemdUser) {
      useSystemd = await opts.hasSystemdUser();
    } else if (currentPlatform === "linux") {
      try {
        const proc = Bun.spawn(["systemctl", "--user", "show-environment"], { stdout: "pipe", stderr: "pipe" });
        useSystemd = (await proc.exited) === 0;
      } catch {
        useSystemd = false;
      }
    }
  }

  if (useSystemd) {
    const configDir = opts.configDir ?? configHome();
    const unitPath = join(userUnitDir(configDir), UNIT_NAME);
    const installOpts: InstallOptions = {
      bunPath,
      scriptPath,
      configDir,
      env: { path: process.env.PATH },
    };

    if (!existsSync(unitPath)) {
      const install = opts.installService ?? installService;
      await install(installOpts, true);
    } else {
      if (opts.startSystemdUnit) {
        await opts.startSystemdUnit(installOpts);
      } else {
        const proc = Bun.spawn(["systemctl", "--user", "start", UNIT_NAME], { stdout: "pipe", stderr: "pipe" });
        const code = await proc.exited;
        if (code !== 0) {
          const stderr = await new Response(proc.stderr).text();
          throw new Error(`Failed to start ${UNIT_NAME}: ${stderr.trim() || `exit ${code}`}`);
        }
      }
    }
  } else {
    const logPath = join(home, "board.log");
    const spawnFn =
      opts.spawnDetached ??
      (async (cmd, args, outPath, env) => {
        mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
        const out = openSync(outPath, "a", 0o600);
        try {
          const child = spawn(cmd, args, {
            detached: true,
            windowsHide: true,
            stdio: ["ignore", out, out],
            env: env as NodeJS.ProcessEnv,
          });
          await new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("spawn", resolve);
          });
          child.unref();
        } finally {
          closeSync(out);
        }
      });

    await spawnFn(bunPath, [scriptPath, "serve"], logPath, {
      ...process.env,
      OMP_HOLOTABLE_HOME: home,
    });
  }

  const timeoutMs = opts.timeoutMs ?? 8000;
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, pollIntervalMs);
    await promise;
    const current = await checkHealth(home);
    if (current.running) return current;
  }

  throw new Error(`Board service failed to start within ${Math.max(1, Math.round(timeoutMs / 1000))}s. Check ${join(home, "board.log")} or systemctl --user status holotable.`);
}
