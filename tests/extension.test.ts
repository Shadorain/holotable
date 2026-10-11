import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import holotableExtension from "../src/plugins/omp/extension.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { startBoard, type Board } from "../src/service.ts";
import { readSelection } from "../src/store/board.ts";
import { createOperation } from "../src/store/operations.ts";
import { fakePorts, noRun, operation } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

interface CommandStub {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
}
interface ToolStub {
  name: string;
  defaultInactive?: boolean;
}

function fixture(kind: "main" | "sub" = "main") {
  const home = mkdtempSync(join(tmpdir(), "holotable-ext-"));
  const prev = process.env.OMP_HOLOTABLE_HOME;
  process.env.OMP_HOLOTABLE_HOME = home;
  cleanup.push(() => {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OMP_HOLOTABLE_HOME;
    else process.env.OMP_HOLOTABLE_HOME = prev;
  });
  const commands = new Map<string, CommandStub>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const notices: Array<{ text: string; type?: string }> = [];
  const statuses: Array<string | undefined> = [];
  const tools = new Map<string, ToolStub>();
  let active = ["read"];
  // A hand-rolled ExtensionAPI: the test double is deliberately narrower than the real surface.
  const pi = {
    registerCommand: (name: string, value: CommandStub) => commands.set(name, value),
    registerTool: (tool: ToolStub) => {
      tools.set(tool.name, tool);
      if (!tool.defaultInactive) active.push(tool.name);
    },
    getActiveTools: () => [...active],
    setActiveTools: async (names: string[]) => void (active = names),
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler),
  };
  const ctx = {
    cwd: home,
    agent: { kind },
    setInterval: (fn: () => void, ms: number) => {
      const timer = setInterval(fn, ms);
      cleanup.push(() => clearInterval(timer));
      return timer;
    },
    clearTimer: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
    ui: {
      notify: (text: string, type?: string) => notices.push({ text, type }),
      setStatus: (_k: string, text?: string) => statuses.push(text),
    },
  } as unknown as ExtensionContext;
  // Starting the board stays in-process: a test must never spawn a service or touch systemd units.
  let started = 0;
  holotableExtension(pi as unknown as ExtensionAPI, {
    startService: async () => {
      started += 1;
      const board = await startBoard({
        home,
        settings: { ...DEFAULT_SETTINGS, port: 0, pollMs: 60_000, sampleMs: 60_000 },
        run: noRun,
        portsFor: () => fakePorts().ports,
      });
      cleanup.push(() => board.close());
      return { running: true, url: board.url, urls: [board.url], pid: process.pid };
    },
  });
  const command = commands.get("holotable") as CommandStub;
  return {
    home,
    started: () => started,
    active: () => active,
    tools,
    commands,
    handlers,
    notices,
    statuses,
    lastStatus: () => statuses.at(-1),
    run: (args: string) => command.handler(args, ctx),
    complete: (prefix: string) => command.getArgumentCompletions?.(prefix),
    start: () => handlers.get("session_start")?.({}, ctx),
    shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
  };
}

test("registers the command and both tools, inactive by default", () => {
  const f = fixture();
  expect(f.commands.has("holotable")).toBe(true);
  expect([...f.tools.keys()].sort()).toEqual(["holotable_queue", "holotable_state"]);
  for (const name of ["holotable_state", "holotable_queue"]) expect(f.tools.get(name)?.defaultInactive).toBe(true);
  expect(f.active()).toEqual(["read"]);
});

test("a board-launched child process registers nothing", () => {
  process.env.OMP_HOLOTABLE_CHILD = "1";
  cleanup.push(() => void delete process.env.OMP_HOLOTABLE_CHILD);
  const f = fixture();
  expect(f.commands.size).toBe(0);
  expect(f.tools.size).toBe(0);
});

test("new selects the operation and the status row says the service is down", async () => {
  const f = fixture();
  await f.start();
  await f.run("new lab --repo /tmp/r --base main");
  await f.run("zone Ops");
  await f.run("add CHR-1 --zone ops");
  expect(f.lastStatus()).toContain("holotable · board not running");
  // The OMP session keeps its own selection; the CLI's is untouched.
  expect(await readSelection(f.home)).toBeNull();
});

test("completions follow created operations and zones", async () => {
  const f = fixture();
  await f.run("new lab --repo /tmp/r --base main");
  await f.run("zone Ops");
  const values = (prefix: string) => f.complete(prefix)?.map((i: { value: string }) => i.value) ?? null;
  expect(values("use ")).toEqual(["use lab "]);
  expect(values("add t --zone ")).toEqual(["add t --zone ops "]);
  expect(values("zzz")).toBeNull();
});

test("a subagent session cannot use the command", async () => {
  const f = fixture("sub");
  await expect(f.run("list")).rejects.toThrow("main session");
});

test("stop is refused: the board belongs to the service now", async () => {
  const f = fixture();
  await f.run("stop");
  expect(f.notices.at(-1)?.text).toContain("service");
});

test("bare /holotable with no service starts it, shows its URL and enables the tools", async () => {
  const f = fixture();
  await f.run("");
  expect(f.started()).toBe(1);
  expect(f.active()).toContain("holotable_state");
  expect(f.active()).toContain("holotable_queue");
  const notice = f.notices.find((n) => n.text.includes("Board:"));
  expect(notice?.text).toContain("127.0.0.1:");
});

test("bare /holotable with a running service shows its URL", async () => {
  const f = fixture();
  await createOperation(f.home, operation());
  const board: Board = await startBoard({
    home: f.home,
    settings: { ...DEFAULT_SETTINGS, port: 0, pollMs: 60_000, sampleMs: 60_000 },
    run: noRun,
    portsFor: () => fakePorts().ports,
  });
  cleanup.push(() => board.close());
  await f.run("");
  const notice = f.notices.find((n) => n.text.includes("Board:"));
  expect(notice?.text).toContain(board.url);
  expect(f.lastStatus()).toContain("holotable ·");
  expect(f.lastStatus()).not.toContain("service not running");
});
