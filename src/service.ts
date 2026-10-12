import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolvePorts } from "./adapters/registry.ts";
import { createBoardService } from "./board.ts";
import type { Access, Operation, Settings } from "./core/types.ts";
import { agentDir } from "./paths.ts";
import { PortError, type Ports, type Run } from "./ports.ts";
import { readOperation } from "./store/operations.ts";
import { migrateHome } from "./store/migrate.ts";
import { createRun } from "./run.ts";
import { createActionRunner } from "./runtime/actions.ts";
import { createAuto } from "./runtime/auto.ts";
import { createEnder } from "./runtime/end.ts";
import { createRecover } from "./runtime/recover.ts";
import { createUsage } from "./usage.ts";
import { createWatcher } from "./runtime/watcher.ts";
import { startServer, type BoardServer } from "./server.ts";
import { readSettings } from "./store/settings.ts";
import { acquireBoard, ensureToken, type BoardInfo, type BoardLock } from "./store/board.ts";

export class ServiceError extends Error {
  constructor(
    readonly code: "locked" | "failed",
    message: string,
    readonly owner: BoardInfo | null = null,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface StartBoardOptions {
  home: string;
  /** Read each pass: cap/pollMs/sampleMs changes apply without restart. Defaults to settings.json. */
  settings?: Settings | (() => Promise<Settings>);
  run?: Run;
  portsFor?: (operation: Operation, settings: Settings) => Ports;
  /** Overrides for this boot only; changing them still takes a restart. */
  access?: Access;
  port?: number;
  /** Close the board on SIGINT/SIGTERM. The CLI wants this; tests and the playground do not. */
  signals?: boolean;
}

export interface Board {
  url: string;
  urls: string[];
  close(): Promise<void>;
  /** Resolves once close() has fully stopped server, timer and lock. */
  closed: Promise<void>;
}

/**
 * The board service: one process owning the lock, HTTP server, watcher and action runner for a home.
 * It launches and watches missions; it never runs them. Everything an operator click does lives here,
 * not in the OMP session.
 */
export async function startBoard(options: StartBoardOptions): Promise<Board> {
  const { home } = options;
  const settings = options.settings ?? (() => readSettings(home));
  const settingsFn = typeof settings === "function" ? settings : async () => settings;
  const run = options.run ?? createRun();
  const portsFor = options.portsFor ?? ((op: Operation, s: Settings) => resolvePorts(op, s, run, agentDir()));

  let stopped = false;
  let timer: Timer | undefined;
  let tickInFlight: Promise<void> | undefined;
  let autoInFlight: Promise<void> | undefined;
  let recoverInFlight: Promise<void> | undefined;
  let boardLock: BoardLock | null = null;
  let server: BoardServer | null = null;
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
  const onSignal = () => void close();
  async function close(): Promise<void> {
    if (stopped) return closed;
    stopped = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    clearTimeout(timer);
    try {
      await server?.close();
      await Promise.allSettled([tickInFlight, autoInFlight, recoverInFlight]);
    } finally {
      try {
        await boardLock?.release();
      } finally {
        resolveClosed();
      }
    }
  }

  const acquired = await acquireBoard(home, (error) => {
    void close().then(() => warn(`board lock lost: ${error.message}`));
  });
  if (!acquired.ok) {
    const owner = acquired.owner;
    throw new ServiceError(
      "locked",
      owner ? `Board already running in pid ${owner.pid}: ${owner.url}` : "Board already running in another process.",
      owner,
    );
  }
  boardLock = acquired.lock;

  // One-time store migrations (projects grouping, workflow -> notes.md) before anything reads.
  try {
    await migrateHome(home);
  } catch (error) {
    await boardLock.release();
    throw error;
  }

  const warned = new Set<string>();
  const warn = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    console.error(`holotable: ${message}`);
  };
  const watcher = createWatcher({ home, now: () => new Date(), settings: settingsFn, portsFor, warn });
  const inFlight = new Map<string, string>();
  const action = createActionRunner({
    home,
    now: () => new Date(),
    settings: settingsFn,
    portsFor,
    extras: watcher.extras,
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
    token: () => randomBytes(3).toString("hex"),
    run,
    inFlight,
  });
  const auto = createAuto({
    home,
    now: () => new Date(),
    settings: settingsFn,
    extras: watcher.extras,
    run: action,
    warn,
  });
  const recover = createRecover({
    home,
    now: () => new Date(),
    settings: settingsFn,
    extras: watcher.extras,
    run: action,
    warn,
  });
  const ender = createEnder({ home, now: () => new Date(), settings: settingsFn, portsFor, run, inFlight });

  let bootSettings: Settings;
  try {
    bootSettings = await settingsFn();
    server = await startServer({
      service: createBoardService(home, {
        extras: watcher.extras,
        refresh: (id) => watcher.pass(id, true),
        action,
        settle: (id) => watcher.pass(id),
        plan: async (opId, ticket) => {
          const operation = await readOperation(home, opId);
          const lane = operation.contacts.find((c) => c.ticket === ticket)?.lane;
          if (!lane) return null;
          const status = watcher.extras(opId).statuses[ticket] ?? (await portsFor(operation, await settingsFn()).fleet.read({ worktree: lane.worktree }));
          if (!status) return null;
          try {
            return await portsFor(operation, await settingsFn()).fleet.readPlan(status);
          } catch (error) {
            if (error instanceof PortError && (error.code === "no-plan" || error.code === "no-session")) return null;
            throw error;
          }
        },
        tracker: async (kind) => portsFor({ tracker: kind } as Operation, await settingsFn()).tracker,
        usage: createUsage({ home }),
        end: ender,
        drafts: {
          // Drafts have no operation: a stub carries only what the frontend factories read. The other
          // ports are never used, but resolvePorts builds them all, so they must be real adapters.
          frontend: async (kind, worktreeRoot) =>
            resolvePorts(
              { frontend: kind, worktreeRoot, tracker: "none", fleet: "omp-mission", delivery: "local-merge" } as Operation,
              await settingsFn(),
              run,
              agentDir(),
            ).frontend,
        },
        run,
        urls: () => server?.urls ?? [],
      }),
      onShutdown: close,
      settings: {
        access: options.access ?? bootSettings.access,
        port: options.port ?? bootSettings.port,
      },
      token: await ensureToken(home),
      run,
      onRebind: async (url, urls) => {
        await boardLock?.publish(url, urls);
      },
    });
    await boardLock.publish(server.url, server.urls);
  } catch (error) {
    await close();
    throw error;
  }

  // Serial over itself (the watcher serializes too): a slow pass moves the next one, never overlaps it.
  let delay = bootSettings.pollMs;
  const tick = async () => {
    try {
      await watcher.pass();
      if (stopped) return;
      // Skip a pass still in flight (slow land/recover) instead of re-entering;
      // failures reach the log rather than being swallowed.
      autoInFlight ??= auto
        .pass()
        .catch((error) => warn(`auto pass: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          autoInFlight = undefined;
        });
      recoverInFlight ??= recover
        .pass()
        .catch((error) => warn(`recover pass: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          recoverInFlight = undefined;
        });
      delay = (await settingsFn()).pollMs;
    } catch (error) {
      warn(`watcher pass: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!stopped) timer = setTimeout(poll, delay);
  };
  function poll(): void {
    tickInFlight = tick().finally(() => {
      tickInFlight = undefined;
    });
  }
  timer = setTimeout(poll, 0);

  if (options.signals) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  return { url: server.url, urls: server.urls, close, closed };
}

// ---- systemd user service (Linux) ----

export const UNIT_NAME = "holotable.service";

export interface InstallOptions {
  /** Directory containing bun; typically dirname(process.execPath). */
  bunPath: string;
  /** Absolute path to bin/holotable.ts. */
  scriptPath: string;
  /** XDG config home; defaults to ~/.config. */
  configDir: string;
  env?: { path?: string; home?: string };
  /** systemctl invocations are reported, never fatal: the unit file is the install. */
  systemctl?: (args: string[]) => Promise<{ code: number; stderr: string }>;
}

function systemctlDefault(): (args: string[]) => Promise<{ code: number; stderr: string }> {
  return async (args) => {
    const proc = Bun.spawn(["systemctl", ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: await proc.exited, stderr: await new Response(proc.stderr).text() };
  };
}

/** The systemd user unit. Environment lines carry the current PATH (and home override) so the service finds orca/gh/omp. */
export function renderUnit(input: { bunPath: string; scriptPath: string; pathEnv: string; holotableHome?: string }): string {
  const lines = [
    "[Unit]",
    "Description=Holotable campaign board",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=3",
    "",
    "[Service]",
    "Type=simple",
    // Limit the board and its CLI children, not missions hosted by Orca/herdr.
    "CPUQuota=25%",
    "MemoryAccounting=yes",
    "MemoryHigh=256M",
    "MemoryMax=512M",
    "TasksMax=64",
    "Nice=10",
    "TimeoutStopSec=15",
    `ExecStart="${input.bunPath}" "${input.scriptPath}" serve`,
    `Environment=PATH=${input.pathEnv}`,
  ];
  if (input.holotableHome) lines.push(`Environment=OMP_HOLOTABLE_HOME=${input.holotableHome}`);
  lines.push("Restart=on-failure", "RestartSec=10", "", "[Install]", "WantedBy=default.target", "");
  return lines.join("\n");
}

export interface InstallResult {
  unitPath: string;
  warnings: string[];
}

export async function installService(opts: InstallOptions, enableNow: boolean): Promise<InstallResult> {
  const dir = join(opts.configDir, "systemd", "user");
  await mkdir(dir, { recursive: true });
  const unitPath = join(dir, UNIT_NAME);
  await Bun.write(
    unitPath,
    renderUnit({
      bunPath: opts.bunPath,
      scriptPath: opts.scriptPath,
      pathEnv: opts.env?.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      ...(opts.env?.home ? { holotableHome: opts.env.home } : {}),
    }),
  );
  const warnings: string[] = [];
  const systemctl = opts.systemctl ?? systemctlDefault();
  for (const args of [["--user", "daemon-reload"], ...(enableNow ? [["--user", "enable", "--now", UNIT_NAME]] : [])]) {
    const result = await systemctl(args);
    if (result.code !== 0) warnings.push(`systemctl ${args.join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return { unitPath, warnings };
}

export async function uninstallService(opts: InstallOptions): Promise<InstallResult> {
  const unitPath = join(opts.configDir, "systemd", "user", UNIT_NAME);
  const warnings: string[] = [];
  const systemctl = opts.systemctl ?? systemctlDefault();
  const result = await systemctl(["--user", "disable", "--now", UNIT_NAME]);
  if (result.code !== 0) warnings.push(`systemctl --user disable --now: ${result.stderr.trim() || `exit ${result.code}`}`);
  await rm(unitPath, { force: true });
  const reload = await systemctl(["--user", "daemon-reload"]);
  if (reload.code !== 0) warnings.push(`systemctl --user daemon-reload: ${reload.stderr.trim() || `exit ${reload.code}`}`);
  return { unitPath, warnings };
}
