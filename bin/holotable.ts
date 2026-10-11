#!/usr/bin/env bun
// holotable: the board service and its store commands, without an OMP session.
//
//   holotable serve [--access A] [--port P]   run the board (lock + HTTP + watcher) in the foreground
//   holotable url                           print the running board URL
//   holotable status                        is the service up?
//   holotable install [--now]               install the systemd user service (Linux)
//   holotable uninstall                     remove it
//   holotable <verb> …                      every /holotable subcommand (new list use zone set add close config)
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { formatUrls } from "../src/access.ts";
import type { Access } from "../src/core/types.ts";
import { holotableHome } from "../src/paths.ts";
import { createHolotableCore } from "../src/plugin/core.ts";
import { installService, ServiceError, startBoard, uninstallService } from "../src/service.ts";
import { readBoardInfo, readSelection, writeSelection } from "../src/store/board.ts";
const HOME = holotableHome();
const SCRIPT = fileURLToPath(import.meta.url);

const CLI_HELP = `holotable: campaign board service and commands.
  holotable serve [--access A] [--port P]   run the board (systemd: holotable install --now)
  holotable url                           print the running board URL
  holotable status                        whether the service is answering
  holotable install [--now]               install the systemd user service (Linux)
  holotable uninstall                     stop and remove the systemd user service
  holotable help                          this text
  holotable <verb> …                      every /holotable verb: project new list use zone set add close config help
The board is one process per OMP_HOLOTABLE_HOME (${HOME}).`;

const fail = (message: string): never => {
  console.error(`holotable: ${message}`);
  process.exit(1);
};

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function serve(argv: string[]): Promise<void> {
  const host = flag(argv, "host");
  const accessFlag = flag(argv, "access");
  const port = flag(argv, "port");
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) > 65535)) fail(`--port must be 0-65535 (got ${port})`);
  // --access wins; the legacy --host flag maps onto the nearest mode.
  const access: Access | undefined =
    accessFlag !== undefined ? (accessFlag as Access) : host ? (host === "127.0.0.1" || host === "localhost" ? "local" : "network") : undefined;
  let board;
  try {
    board = await startBoard({
      home: HOME,
      ...(access ? { access } : {}),
      ...(port !== undefined ? { port: Number(port) } : {}),
      signals: true,
    });
  } catch (error) {
    if (error instanceof ServiceError && error.code === "locked") fail(error.message);
    throw error;
  }
  const urls = board.urls.length > 0 ? board.urls : [board.url];
  console.log(`Board:\n${formatUrls(urls)}`);
  console.log("Keep the full URL private. HTTP is unencrypted; use a trusted network or SSH tunnel.");
  await board.closed;
}

function installOptions() {
  return {
    bunPath: process.execPath,
    scriptPath: SCRIPT,
    configDir: process.env.XDG_CONFIG_HOME || `${homedir()}/.config`,
    env: { path: process.env.PATH, ...(process.env.OMP_HOLOTABLE_HOME ? { home: process.env.OMP_HOLOTABLE_HOME } : {}) },
  };
}

function install(argv: string[]): Promise<void> | void {
  const now = argv.includes("--now");
  if (platform() !== "linux")
    return fail(`no systemd here. Run the board in the foreground: ${process.execPath} ${SCRIPT} serve`);
  return installService(installOptions(), now).then(({ unitPath, warnings }) => {
    console.log(`Installed ${unitPath}`);
    for (const warning of warnings) console.error(`holotable: warning: ${warning}`);
    if (!now) console.log(`Start it with: systemctl --user enable --now holotable`);
  });
}

function uninstall(): Promise<void> | void {
  if (platform() !== "linux") return fail("no systemd here; nothing to uninstall");
  return uninstallService(installOptions()).then(({ unitPath, warnings }) => {
    console.log(`Removed ${unitPath}`);
    for (const warning of warnings) console.error(`holotable: warning: ${warning}`);
  });
}

async function main(argv: string[]): Promise<void> {
  const [verb, ...rest] = argv;
  switch (verb) {
    case undefined: {
      const core = createHolotableCore({ home: HOME, now: () => new Date() });
      await core.recordRecent(process.cwd());
      const health = await core.ensureService();
      const urls = health.urls.length > 0 ? health.urls : health.url ? [health.url] : [];
      console.log(`Board:\n${formatUrls(urls)}`);
      console.log("Keep the full URL private. HTTP is unencrypted; use a trusted network or SSH tunnel.");
      return;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(CLI_HELP);
      return;
    case "serve":
      return serve(rest);
    case "url": {
      const info = await readBoardInfo(HOME);
      if (!info) fail(`board not running. Start it with 'holotable serve' or 'holotable install --now'`);
      const urls = info.urls && info.urls.length > 0 ? info.urls : [info.url];
      console.log(formatUrls(urls));
      return;
    }
    case "status": {
      const { running, url, pid } = await createHolotableCore({ home: HOME, now: () => new Date() }).service();
      if (!running) {
        console.log("holotable service is not running. Start it with 'holotable serve' or 'holotable install --now'");
        process.exit(3);
      }
      console.log(`running (pid ${pid}): ${url}`);
      return;
    }
    case "install":
      return install(rest);
    case "uninstall":
      return uninstall();
    default: {
      // Every /holotable subcommand works here too, through the same plugin core.
      const core = createHolotableCore({ home: HOME, now: () => new Date() });
      const args = [verb, ...rest].map((token) => (/[\s"]/.test(token) ? JSON.stringify(token) : token)).join(" ");
      const outcome = await core.runCommand(args, { cwd: process.cwd(), current: await readSelection(HOME) });
      if (outcome.current !== undefined) await writeSelection(HOME, outcome.current);
      console.log(outcome.message);
    }
  }
}

await main(process.argv.slice(2)).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
