import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import type { Run } from "../ports.ts";

/**
 * The bead graph of a beads mission lives in a Dolt SQL server. `bd` can auto-start one, but a server
 * started from inside a mission pane belongs to that pane's process group: the Orca reaper expires it
 * after an hour, and nothing restarts it after an OOM kill. Every mission on that repo then holds with
 * "Dolt server unreachable".
 *
 * The board therefore owns a supervised systemd user unit per repo (`Restart=always`) and sets
 * `dolt.auto-start: false` so no pane starts a competing copy. The board never parents the server: a
 * board restart would take every mission's graph with it.
 */
export const DOLT_UNIT_PREFIX = "beads-dolt-";

export interface DoltState {
  /** No `.beads` directory, or it is not a server-mode database: nothing to manage. */
  managed: boolean;
  unit: string | null;
  port: number | null;
  /** systemd's view: "active", "failed", "inactive", "missing" (no unit file), or null when systemctl failed. */
  unitState: string | null;
  /** A TCP connect to the configured port succeeded. */
  reachable: boolean | null;
  /** True once `.beads/config.yaml` carries `dolt.auto-start: false`. */
  autoStartDisabled: boolean;
  detail: string;
}

export const unitName = (projectId: string): string => `${DOLT_UNIT_PREFIX}${projectId}.service`;

/** `.beads/dolt/config.yaml`, which the unit passes to `dolt sql-server` and `bd` reads the port from. */
export const serverConfigPath = (repo: string): string => join(repo, ".beads", "dolt", "config.yaml");

export function renderServerConfig(repo: string, port: number): string {
  return [
    "log_level: warning",
    "behavior:",
    "    auto_gc_behavior:",
    "        archive_level: 0",
    "listener:",
    "    host: 127.0.0.1",
    `    port: ${port}`,
    `cfg_dir: ${join(repo, ".beads", "dolt", ".doltcfg")}`,
    "user_session_vars: []",
    "jwks: []",
    "",
  ].join("\n");
}

/**
 * The unit runs `dolt sql-server` in the foreground so systemd owns its lifetime. `bd dolt start`
 * is never used: it rewrites the port file and leaves the process parented to whoever called it.
 */
export function renderUnit(input: { projectName: string; repo: string; doltPath: string }): string {
  const beads = join(input.repo, ".beads");
  return [
    `# Managed by holotable. ${input.projectName}'s bead graph; port in ${join(beads, "dolt", "config.yaml")}.`,
    "# bd has dolt.auto-start: false, so no mission pane starts a copy the Orca reaper would expire.",
    "# Never `bd dolt start`/`stop` here: they rewrite the port file and dolt-server-config.yaml.",
    "[Unit]",
    `Description=Beads Dolt SQL server for ${input.projectName}`,
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${join(beads, "dolt")}`,
    `Environment=BEADS_DIR=${beads}`,
    `ExecStart="${input.doltPath}" sql-server --config "${join(beads, "dolt", "config.yaml")}"`,
    "Restart=always",
    "RestartSec=2",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Deterministic per-repo port in the ephemeral range, so two projects never collide. */
export function defaultPort(repo: string): number {
  let hash = 2166136261;
  for (const code of Buffer.from(repo, "utf8")) hash = Math.imul(hash ^ code, 16777619) >>> 0;
  return 30000 + (hash % 20000);
}

/** The port `bd` will use: the server config the unit owns, else the derived default. */
export async function readPort(repo: string): Promise<number | null> {
  const text = await readFile(serverConfigPath(repo), "utf8").catch(() => null);
  if (text === null) return null;
  const port = Number(/^\s*port:\s*(\d+)\s*$/m.exec(text)?.[1]);
  return Number.isInteger(port) ? port : null;
}

async function reachable(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

/** True when this repo keeps its beads graph in a Dolt server (not the embedded single-writer backend). */
export async function serverMode(repo: string): Promise<boolean> {
  const text = await readFile(join(repo, ".beads", "metadata.json"), "utf8").catch(() => null);
  if (text === null) return false;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && (value as { dolt_mode?: unknown }).dolt_mode === "server";
  } catch {
    return false;
  }
}

async function autoStartDisabled(repo: string): Promise<boolean> {
  const text = await readFile(join(repo, ".beads", "config.yaml"), "utf8").catch(() => null);
  return text !== null && /^\s*dolt\.auto-start:\s*false\s*$/m.test(text);
}

export interface DoltDeps {
  run: Run;
  /** Overridable for tests; the real one shells out to systemctl --user. */
  systemctl?: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
}

const systemctlOf = (deps: DoltDeps) =>
  deps.systemctl ?? ((args: string[], cwd: string) => deps.run("systemctl", ["--user", ...args], cwd));

/** What the board shows for this project's graph server, with no side effects. */
export async function doltState(projectId: string, repo: string, deps: DoltDeps): Promise<DoltState> {
  if (!(await serverMode(repo)))
    return { managed: false, unit: null, port: null, unitState: null, reachable: null, autoStartDisabled: false, detail: "No server-mode bead database in this repo" };
  const unit = unitName(projectId);
  const port = (await readPort(repo)) ?? defaultPort(repo);
  const shown = await systemctlOf(deps)(["is-active", unit], repo);
  const raw = shown.stdout.trim() || shown.stderr.trim();
  const unitState = raw.length ? (raw === "inactive" && !(await unitInstalled(unit, deps, repo)) ? "missing" : raw) : null;
  const up = await reachable(port);
  const disabled = await autoStartDisabled(repo);
  const detail = unitState === "missing"
    ? "Not managed yet: Install runs dolt under systemd and turns off bd auto-start"
    : up
      ? `Serving on 127.0.0.1:${port}`
      : unitState === "active"
        ? `Unit is active but nothing answers on ${port}`
        : `Unit ${unitState ?? "state unknown"}; missions hold until it is back`;
  return { managed: true, unit, port, unitState, reachable: up, autoStartDisabled: disabled, detail };
}

async function unitInstalled(unit: string, deps: DoltDeps, cwd: string): Promise<boolean> {
  const shown = await systemctlOf(deps)(["cat", unit], cwd);
  return shown.code === 0;
}

export interface DoltWriteDeps extends DoltDeps {
  /** Absolute path of the `dolt` binary; the unit must not depend on PATH. */
  doltPath: string;
  unitDir: string;
  write: (path: string, content: string) => Promise<void>;
  read: (path: string) => Promise<string | null>;
}

export interface InstallDoltResult {
  unit: string;
  unitPath: string;
  port: number;
  warnings: string[];
}

/**
 * Write (or refresh) the unit, pin the port, disable `bd` auto-start, and enable the service. Idempotent:
 * an existing port is kept so a running graph is not moved out from under live missions.
 */
export async function installDolt(
  projectId: string,
  projectName: string,
  repo: string,
  deps: DoltWriteDeps,
): Promise<InstallDoltResult> {
  if (!(await serverMode(repo)))
    throw new Error(`${repo} has no server-mode bead database (.beads/metadata.json dolt_mode: server)`);
  const unit = unitName(projectId);
  const unitPath = join(deps.unitDir, unit);
  const port = (await readPort(repo)) ?? defaultPort(repo);
  await deps.write(serverConfigPath(repo), renderServerConfig(repo, port));
  await deps.write(unitPath, renderUnit({ projectName, repo, doltPath: deps.doltPath }));

  const warnings: string[] = [];
  // bd would otherwise start its own server whenever the unit is briefly down, and that copy dies with its pane.
  const configPath = join(repo, ".beads", "config.yaml");
  const config = (await deps.read(configPath)) ?? "";
  if (!/^\s*dolt\.auto-start:/m.test(config)) {
    const note = "\n# holotable manages the Dolt server as a systemd unit; a pane must never start its own.\ndolt.auto-start: false\n";
    await deps.write(configPath, `${config.replace(/\s*$/, "")}\n${note}`);
  } else if (!/^\s*dolt\.auto-start:\s*false\s*$/m.test(config)) {
    await deps.write(configPath, config.replace(/^\s*dolt\.auto-start:.*$/m, "dolt.auto-start: false"));
  }

  const systemctl = systemctlOf(deps);
  for (const args of [["daemon-reload"], ["enable", "--now", unit]]) {
    const result = await systemctl(args, repo);
    if (result.code !== 0) warnings.push(`systemctl --user ${args.join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return { unit, unitPath, port, warnings };
}

/** Restart the managed unit; the operator's "it is down" button. */
export async function restartDolt(projectId: string, repo: string, deps: DoltDeps): Promise<void> {
  const unit = unitName(projectId);
  const result = await systemctlOf(deps)(["restart", unit], repo);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `systemctl --user restart ${unit} failed`);
}
