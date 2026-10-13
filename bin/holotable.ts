#!/usr/bin/env bun
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUrls } from "../src/access.ts";
import type { CliReply } from "../src/adapters/holotable-cli.ts";
import { HELP } from "../src/commands.ts";
import { ACCESS_MODES } from "../src/core/types.ts";
import type { Access } from "../src/core/types.ts";
import { holotableHome } from "../src/paths.ts";
import { createHolotableCore } from "../src/plugin/core.ts";
import { stopService } from "../src/plugin/client.ts";
import { installService, startBoard, uninstallService } from "../src/service.ts";
import type { InstallOptions } from "../src/service.ts";
import { readSelection, writeSelection } from "../src/store/board.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
let home = resolve(holotableHome());
let json = false;
let explicitCurrent = false;
let current: string | null = null;

function print(reply: CliReply, code = 0): void {
  console.log(json ? JSON.stringify(reply) : reply.message);
  process.exitCode = code;
}

async function main(): Promise<void> {
  while (["--home", "--json", "--current"].includes(argv[0] ?? "")) {
    const option = argv.shift();
    if (option === "--json") {
      json = true;
      continue;
    }
    const value = argv.shift();
    if (value === undefined || (option === "--home" && !value) || value.startsWith("--"))
      throw new Error(`${option} needs a value.`);
    if (option === "--home") home = resolve(value);
    else {
      explicitCurrent = true;
      current = value || null;
    }
  }
  const [verb, ...rest] = argv;
  const core = createHolotableCore({ home, now: () => new Date(), current: () => current });
  if (!explicitCurrent) current = await readSelection(home);
  switch (verb) {
    case "help":
    case "--help":
    case "-h":
      return print({ message: `holotable [--home PATH] [--json] [--current ID] <command>
One board per home: ${home}
Global options precede the command. --current overrides selection without changing the shell's selection.
  holotable serve [--access A] [--port P]   foreground board
  holotable install [--now]               install the Linux systemd user service
  holotable uninstall                     stop and remove that service; keep data
${HELP.replaceAll("/holotable", "holotable")}` });
    case "serve": {
      if (json) throw new Error("serve is a foreground process; use --json start for machine control.");
      let access: Access | undefined;
      let port: number | undefined;
      for (let i = 0; i < rest.length; i += 2) {
        const flag = rest[i], value = rest[i + 1];
        if (flag === "--access" && ACCESS_MODES.includes(value as Access)) access = value as Access;
        else if (flag === "--port" && value !== undefined && /^\d+$/.test(value) && Number(value) <= 65535) port = Number(value);
        else throw new Error("Usage: holotable serve [--access local|tailscale|network] [--port 0-65535]");
      }
      const board = await startBoard({ home, access, port, signals: true });
      print({ message: `Board:\n${formatUrls(board.urls)}\nKeep the full URL private. HTTP is unencrypted; use a trusted network or SSH tunnel.` });
      await board.closed;
      return;
    }
    case undefined:
    case "start":
    case "restart": {
      if (rest.length) throw new Error(`Usage: holotable ${verb ?? "start"}`);
      if (verb === "restart") await stopService(home);
      await core.recordRecent(process.cwd());
      const service = await core.ensureService();
      const urls = service.urls?.length ? service.urls : service.url ? [service.url] : [];
      return print({ service, message: `Board:\n${formatUrls(urls)}\nKeep the full URL private. HTTP is unencrypted; use a trusted network or SSH tunnel.` });
    }
    case "stop": {
      if (rest.length) throw new Error("Usage: holotable stop");
      const service = await stopService(home);
      return print({ service, message: service.running ? "Previous board stopped; another instance is now running." : "Board stopped. Mission panes and operation data are unchanged." });
    }
    case "status":
    case "url": {
      if (rest.length) throw new Error(`Usage: holotable ${verb}`);
      const service = await core.service();
      if (!service.running) return print({ service, message: "Board is not running. Start it with holotable start." }, 3);
      return print({ service, message: verb === "url" ? formatUrls(service.urls ?? [service.url as string]) : `running (pid ${service.pid})\n${formatUrls(service.urls ?? [service.url as string])}` });
    }
    case "install":
    case "uninstall": {
      if (platform() !== "linux") throw new Error("Systemd installation is Linux-only; holotable start/stop/restart work without it.");
      if (home !== join(homedir(), ".omp", "agent", "holotable"))
        throw new Error("The systemd unit manages only the default home. Use holotable --home PATH start for a separate instance.");
      if (rest.some((arg) => verb !== "install" || arg !== "--now")) throw new Error(`Usage: holotable ${verb}${verb === "install" ? " [--now]" : ""}`);
      const options: InstallOptions = {
        bunPath: process.execPath,
        scriptPath: SCRIPT,
        configDir: process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        env: { path: process.env.PATH },
      };
      const result = verb === "install" ? await installService(options, rest.includes("--now")) : await uninstallService(options);
      for (const warning of result.warnings) console.error(`holotable: warning: ${warning}`);
      return print({ message: `${verb === "install" ? "Installed" : "Removed"} ${result.unitPath}${verb === "install" && !rest.includes("--now") ? "\nStart with holotable start; install --now also enables login startup." : ""}` });
    }
    default: {
      const args = argv.map((token) => !token || /[\s"\\]/.test(token) ? JSON.stringify(token) : token).join(" ");
      const outcome = await core.runCommand(args, { cwd: process.cwd(), current });
      if (outcome.current !== undefined && !explicitCurrent) await writeSelection(home, outcome.current);
      if (verb === "new" && rest.includes("--auto")) {
        try {
          await core.ensureService();
        } catch (error) {
          throw new Error(`${outcome.message}\nBoard could not start: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      print(outcome);
    }
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(`holotable: ${message}`);
  process.exitCode = 1;
});
