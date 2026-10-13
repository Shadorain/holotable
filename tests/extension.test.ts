import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import holotableExtension from "../src/plugins/omp/extension.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { startBoard } from "../src/service.ts";
import type { Board } from "../src/service.ts";
import { readSelection } from "../src/store/board.ts";
import { serviceHealth, stopService } from "../src/plugin/client.ts";
import { createOperation, readOperation } from "../src/store/operations.ts";
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
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  process.env.OMP_HOLOTABLE_HOME = home;
  writeFileSync(join(home, "settings.json"), JSON.stringify({
    ...DEFAULT_SETTINGS, access: "local", port: 0, pollMs: 60_000, sampleMs: 60_000,
    defaults: { tracker: "none", fleet: "none", frontend: "none", delivery: "none", pause: false },
  }));
  cleanup.push(async () => {
    await stopService(home);
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OMP_HOLOTABLE_HOME;
    else process.env.OMP_HOLOTABLE_HOME = prev;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
  });
  const commands = new Map<string, CommandStub>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const notices: Array<{ text: string; type?: string }> = [];
  const statuses: Array<string | undefined> = [];
  const tools = new Map<string, ToolStub>();
  const timers = new Set<Timer>();
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
      timers.add(timer);
      cleanup.push(() => clearInterval(timer));
      return timer;
    },
    clearTimer: (timer: Timer) => {
      clearInterval(timer);
      timers.delete(timer);
    },
    ui: {
      theme: { fg: (_tone: string, text: string) => text, symbol: () => "" },
      notify: (text: string, type?: string) => notices.push({ text, type }),
      setStatus: (_k: string, text?: string) => statuses.push(text),
    },
  } as unknown as ExtensionContext;
  async function serve(): Promise<Board> {
    const board = await startBoard({
      home,
      settings: { ...DEFAULT_SETTINGS, port: 0, pollMs: 60_000, sampleMs: 60_000 },
      run: noRun,
      portsFor: () => fakePorts().ports,
    });
    cleanup.push(() => board.close());
    return board;
  }
  holotableExtension(pi as unknown as ExtensionAPI);
  const command = commands.get("holotable") as CommandStub;
  return {
    home,
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
    switch: () => handlers.get("session_switch")?.({}, ctx),
    branch: () => handlers.get("session_branch")?.({}, ctx),
    timers: () => timers.size,
    serve,
    shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
  };
}


test("a board-launched child process registers nothing", () => {
  process.env.OMP_HOLOTABLE_CHILD = "1";
  cleanup.push(() => void delete process.env.OMP_HOLOTABLE_CHILD);
  const f = fixture();
  expect(f.commands.size).toBe(0);
  expect(f.tools.size).toBe(0);
});

test("store commands select locally without starting the board service", async () => {
  const f = fixture();
  await f.start();
  await f.run("new lab --repo /tmp/r --base main");
  await f.run("zone Ops");
  await f.run("add CHR-1 --zone ops");
  expect((await serviceHealth(f.home)).running).toBe(false);
  expect(f.active()).toContain("holotable_state");
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

test("stop shuts down only the selected board and deactivates this OMP session", async () => {
  const f = fixture();
  await createOperation(f.home, operation());
  await f.serve();
  await f.run("");
  await f.run("use lab");
  await f.run("stop");
  expect((await serviceHealth(f.home)).running).toBe(false);
  expect(f.lastStatus()).toBeUndefined();
  expect(f.timers()).toBe(0);
  expect(f.active()).toEqual(["read"]);
  await f.run("zone Retained");
  await f.run("add CHR-AFTER --zone retained");
  expect((await readOperation(f.home, "lab")).contacts.some((c) => c.ticket === "CHR-AFTER")).toBe(true);
  expect(await readSelection(f.home)).toBeNull();
});

test("bare /holotable with no service starts it, shows its URL and enables the tools", async () => {
  const f = fixture();
  await f.run("");
  expect(f.active()).toContain("holotable_state");
  expect(f.active()).toContain("holotable_queue");
  const notice = f.notices.find((n) => n.text.includes("Board:"));
  expect(notice?.text).toContain("127.0.0.1:");
});

test("bare /holotable with a running service shows its URL", async () => {
  const f = fixture();
  await createOperation(f.home, operation());
  const board = await f.serve();
  await f.run("");
  const notice = f.notices.find((n) => n.text.includes("Board:"));
  expect(notice?.text).toContain(board.url);
});

test("a fresh session stays inactive even when a board is already running", async () => {
  const f = fixture();
  await createOperation(f.home, operation());
  await f.serve();
  await f.start();
  await f.switch();
  await f.branch();
  expect(f.statuses.every((status) => status === undefined)).toBe(true);
  expect(f.timers()).toBe(0);
  expect(f.active()).toEqual(["read"]);
  expect(f.tools.size).toBe(0);
  expect((await serviceHealth(f.home)).running).toBe(true);
});

test("an explicitly opened empty board has no status row", async () => {
  const f = fixture();
  await f.start();
  await f.run("");
  expect(f.lastStatus()).toBeUndefined();
  expect(f.active()).toContain("holotable_queue");
  expect(f.timers()).toBe(1);
  await f.shutdown();
  expect(f.timers()).toBe(0);
  expect(f.active()).toEqual(["read"]);
});

test("switching or branching clears activation until this session runs holotable", async () => {
  const f = fixture();
  await createOperation(f.home, operation());
  await f.serve();
  await f.run("");
  await f.switch();
  expect(f.lastStatus()).toBeUndefined();
  expect(f.timers()).toBe(0);
  expect(f.active()).toEqual(["read"]);
  await f.run("use lab");
  expect(f.active()).toContain("holotable_state");
  expect(f.timers()).toBe(1);
  await f.branch();
  expect(f.lastStatus()).toBeUndefined();
  expect(f.timers()).toBe(0);
  expect(f.active()).toEqual(["read"]);
});
