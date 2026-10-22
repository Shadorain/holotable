import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Operation } from "../../src/core/types.ts";
import { PortError, type FleetPort } from "../../src/ports.ts";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { ActionError } from "../../src/runtime/errors.ts";
import type { LanderDeps } from "../../src/runtime/lander.ts";
import { launchContact } from "../../src/runtime/launcher.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { appendEvent, readEvents } from "../../src/store/events.ts";
import { readOperation } from "../../src/store/operations.ts";
import { contact, fakePorts, noRun, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

async function setup(over: Partial<Operation> = {}, deps: Partial<LanderDeps> = {}) {
  const home = tempDir("launch", dirs);
  await seedOperation(home, {
    contacts: [contact("a"), contact("b", { blockedBy: ["a"] }), contact("n", { kind: "decision" })],
    ...over,
  });
  const fake = fakePorts();
  const sleeps: number[] = [];
  const base: LanderDeps = {
    home,
    now: () => new Date("2026-01-01T01:00:00Z"),
    settings: async () => DEFAULT_SETTINGS,
    portsFor: () => fake.ports,
    extras: () => ({ load: { live: 0, open: 0 } }),
    sleep: async (ms) => void sleeps.push(ms),
    token: () => "abc123",
    socketWaitMs: 3_000,
    run: noRun,
    ...deps,
  };
  const act = createActionRunner(base);
  const readyChild = () => {
    fake.world.statuses.set("/wt/a", status({ worktree: "/wt/a" }));
    fake.world.alive.add("/tmp/x.sock");
  };
  // The seed's queued events are noise here: show only what the action itself recorded.
  const events = async () =>
    (await readEvents(home, "lab"))
      .filter((e) => e.kind !== "queued" && e.kind !== "blocked")
      .map((e) => (e.kind === "operator" ? `operator:${e.op}:${e.ok}` : e.kind));
  const reject = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(ActionError);
      return error as ActionError;
    }
    throw new Error("expected the action to be refused");
  };
  return { home, fake, act, readyChild, events, sleeps, reject };
}

test("refusals happen before any port call, in the documented order", async () => {
  const t = await setup();
  expect((await t.reject(t.act({ op: "lab", contact: "b", action: "launch", args: {} }))).message).toBe("blocked by a");
  expect((await t.reject(t.act({ op: "lab", contact: "n", action: "launch", args: {} }))).status).toBe(409);
  expect(t.fake.calls).toEqual([]);

  const capped = await setup({}, { extras: () => ({ load: { live: 8, open: 8 } }) });
  expect((await capped.reject(capped.act({ op: "lab", contact: "a", action: "launch", args: {} }))).message).toBe("cap 8/8 omp");
  expect(capped.fake.calls).toEqual([]);

  const none = await setup({ frontend: "none" });
  expect((await none.reject(none.act({ op: "lab", contact: "a", action: "launch", args: {} }))).message).toContain("no frontend");
  const noFleet = await setup({ fleet: "none" });
  expect((await noFleet.reject(noFleet.act({ op: "lab", contact: "a", action: "launch", args: {} }))).message).toBe("no fleet configured");
});

test("memory refusal preserves the lane and a retry succeeds after headroom returns", async () => {
  let available = 100 * 1024 * 1024;
  const t = await setup({}, { availableMemory: () => available });
  const before = await readOperation(t.home, "lab");
  const error = await t.reject(t.act({ op: "lab", contact: "a", action: "launch", args: {} }));
  expect(error.code).toBe("memory-pressure");
  expect(await readOperation(t.home, "lab")).toEqual(before);
  expect(t.fake.count("frontend.openTerminal")).toBe(0);
  available = 1200 * 1024 * 1024;
  t.readyChild();
  await t.act({ op: "lab", contact: "a", action: "launch", args: {} });
  expect((await readOperation(t.home, "lab")).contacts[0]?.lane?.terminal).not.toBeNull();
});

test("launch runs the steps in order, records the lane, and ends at socket-up", async () => {
  const t = await setup({ tracker: "linear", contacts: [contact("CHR-1"), contact("CHR-2", { blockedBy: ["CHR-1"] })] });
  t.fake.world.statuses.set("/wt/chr-1", status({ worktree: "/wt/chr-1" }));
  t.fake.world.alive.add("/tmp/x.sock");
  await t.act({ op: "lab", contact: "CHR-1", action: "launch", args: {} });
  expect(t.fake.calls.map((c) => `${c.port}.${c.method}`)).toEqual([
    "frontend.ensureRepo",
    "frontend.createWorkspace",
    "fleet.launch",
    "frontend.openTerminal",
    "fleet.read",
    "fleet.ping",
  ]);
  expect(t.fake.calls[1]?.args).toMatchObject({ repo: "/tmp/lab", name: "chr-1", base: "main", ticket: "CHR-1" });
  const opened = t.fake.calls[3]?.args as { worktree: string; argv: string[]; env: Record<string, string> };
  expect(opened).toMatchObject({ worktree: "/wt/chr-1", title: "CHR-1 Lab", env: { FAKE_LAUNCH: "CHR-1" } });
  expect(readFileSync(opened.argv[2] as string, "utf8")).toBe("plan:\n  defaultOnStartup: true\n");
  const op = await readOperation(t.home, "lab");
  expect(op.contacts[0]?.lane).toEqual({ worktree: "/wt/chr-1", branch: "b/chr-1", frontend: "orca", terminal: { handle: "fake", incarnationId: "fake-inc" } });
  expect(await t.events()).toEqual(["launched", "socket-up", "operator:launch:true"]);
});

test("first-terminal launch records one child and preserves its model across a socket timeout", async () => {
  const t = await setup();
  let workspaces = 0;
  const first = { handle: "first", incarnationId: "first-inc" };
  t.fake.ports.frontend.createWorkspaceWithTerminal = async ({ startup }) => {
    workspaces++;
    expect(startup.env).toEqual({ FAKE_LAUNCH: "a" });
    return { worktree: "/wt/a", branch: "b/a", terminal: first };
  };
  const failed = await t.reject(t.act({ op: "lab", contact: "a", action: "launch", args: { model: "provider/model" } }));
  expect(failed.message).toContain("socket: no control socket");
  expect((await readOperation(t.home, "lab")).contacts[0]?.lane).toMatchObject({
    worktree: "/wt/a", terminal: first, model: "provider/model",
  });
  expect(t.fake.count("frontend.openTerminal")).toBe(0);
  expect((await readEvents(t.home, "lab")).filter((event) => event.kind === "launched")).toHaveLength(1);
  await t.reject(t.act({ op: "lab", contact: "a", action: "launch", args: {} }));
  expect(workspaces).toBe(1);
});

test("a tracker-less operation passes no ticket to the workspace", async () => {
  const t = await setup();
  t.readyChild();
  await t.act({ op: "lab", contact: "a", action: "launch", args: {} });
  expect(t.fake.calls.find((c) => c.method === "createWorkspace")?.args).toMatchObject({ name: "a", ticket: null });
});

test("a closer on a Linear operation gets a token-named workspace with no issue link, its brief and a report folder", async () => {
  const t = await setup({ tracker: "linear", contacts: [contact("CHR-1", { lane: lane("/wt/chr-1", "t1", "b/chr-1") }), contact("CLOSER", { kind: "closer", title: "Closer review" })] });
  await appendEvent(t.home, "lab", { v: 1, at: "2026-01-01T00:30:00.000Z", kind: "landed", contact: "CHR-1", via: "pr" });
  t.fake.world.statuses.set("/wt/closer-abc123", status({ worktree: "/wt/closer-abc123" }));
  t.fake.world.alive.add("/tmp/x.sock");
  await t.act({ op: "lab", contact: "CLOSER", action: "launch", args: {} });
  expect(t.fake.calls.find((c) => c.method === "createWorkspace")?.args).toMatchObject({ name: "closer-abc123", ticket: null });
  // The fake fleet records the launch input it was given; the closer's carries the generated brief.
  const input = t.fake.calls.find((c) => c.method === "launch")?.args as Parameters<FleetPort["launch"]>[0];
  const reportPath = join(t.home, "operations", "lab", "closer", "CLOSER.json");
  expect(input.closerBrief).toContain(`write your report as JSON to \`${reportPath}\``);
  expect(input.closerBrief).toContain("- CHR-1 (implement) — branch b/chr-1 · landed 2026-01-01 00:30 UTC");
  expect(existsSync(join(t.home, "operations", "lab", "closer"))).toBe(true);
});

test("a failed workspace step is recorded and a second launch retries it", async () => {
  const t = await setup();
  t.fake.world.fail.set("frontend.createWorkspace", new Error("orca is down"));
  const failure = await t.reject(t.act({ op: "lab", contact: "a", action: "launch", args: {} }));
  expect(failure).toMatchObject({ status: 502, code: "launch-failed" });
  expect(failure.message).toBe("workspace: orca is down");
  expect((await readOperation(t.home, "lab")).contacts[0]?.lane).toBeNull();
  expect(await t.events()).toEqual(["launch-failed", "operator:launch:false"]);
  t.fake.world.fail.clear();
  t.readyChild();
  await t.act({ op: "lab", contact: "a", action: "launch", args: {} });
  expect((await readOperation(t.home, "lab")).contacts[0]?.lane?.terminal).not.toBeNull();
});

test("a launch that stopped after the worktree resumes without creating another", async () => {
  const t = await setup();
  t.fake.world.fail.set("frontend.openTerminal", new Error("no pane"));
  const failure = await t.reject(t.act({ op: "lab", contact: "a", action: "launch", args: {} }));
  expect(failure.message).toBe("terminal: no pane");
  expect((await readOperation(t.home, "lab")).contacts[0]?.lane).toMatchObject({ worktree: "/wt/a", terminal: null });
  t.fake.world.fail.clear();
  t.readyChild();
  await t.act({ op: "lab", contact: "a", action: "launch", args: {} });
  expect(t.fake.count("frontend.createWorkspace")).toBe(1);
  expect(t.fake.count("frontend.openTerminal")).toBe(2);
  expect((await readOperation(t.home, "lab")).contacts[0]?.lane?.terminal).not.toBeNull();
});

test("no control socket within the budget: launch-failed, lane kept, no second launch", async () => {
  const t = await setup();
  const failure = await t.reject(t.act({ op: "lab", contact: "a", action: "launch", args: {} }));
  expect(failure).toMatchObject({ code: "launch-failed" });
  expect(failure.message).toContain("socket: no control socket after 3 s");
  expect(t.fake.count("fleet.read")).toBe(4);
  expect(t.sleeps).toEqual([1000, 1000, 1000]);
  expect((await readOperation(t.home, "lab")).contacts[0]?.lane?.terminal).not.toBeNull();
  const again = await t.reject(t.act({ op: "lab", contact: "a", action: "launch", args: {} }));
  expect(again.status).toBe(409);
  expect(t.fake.count("frontend.openTerminal")).toBe(1);
});

test("a second click during a launch is refused as busy", async () => {
  let release!: () => void;
  const t = await setup();
  t.fake.world.hold = new Promise<void>((resolve) => (release = resolve));
  t.readyChild();
  const first = t.act({ op: "lab", contact: "a", action: "launch", args: {} });
  const second = await t.reject(t.act({ op: "lab", contact: "a", action: "launch", args: {} }));
  expect(second).toMatchObject({ status: 409, code: "busy" });
  release();
  await first;
  expect(t.fake.count("frontend.createWorkspace")).toBe(1);
});

test("a conflict contact launches in its prepared lane with the conflicted paths", async () => {
  const t = await setup({
    contacts: [
      contact("a", { lane: lane("/wt/a", "t1") }),
      contact("a-conflict-1", { kind: "conflict", conflictOf: "a", lane: lane("/wt/conflict-abc123", null, "b/conflict") }),
    ],
  });
  t.fake.world.statuses.set("/wt/conflict-abc123", status({ worktree: "/wt/conflict-abc123" }));
  t.fake.world.alive.add("/tmp/x.sock");
  await appendEvent(t.home, "lab", { v: 1, at: "2026-01-01T00:00:01.000Z", kind: "socket-up", contact: "a", generation: 1 });
  await appendEvent(t.home, "lab", { v: 1, at: "2026-01-01T00:00:02.000Z", kind: "launch-failed", contact: "a-conflict-1", step: "terminal", error: "x" });
  const deps = { home: t.home, now: () => new Date("2026-01-01T01:00:00Z"), settings: async () => DEFAULT_SETTINGS, portsFor: () => t.fake.ports, extras: () => ({ load: { live: 0, open: 0 } }), sleep: async () => {}, token: () => "zzzzzz", socketWaitMs: 0 };
  await launchContact(deps, "lab", "a-conflict-1", { conflictPaths: ["src/x.ts"] });
  expect(t.fake.count("frontend.createWorkspace")).toBe(0);
  expect(t.fake.calls.find((c) => c.method === "launch")?.args).toMatchObject({ conflictPaths: ["src/x.ts"], worktree: "/wt/conflict-abc123" });
  expect(readFileSync(join(t.home, "launch", "plan-default.yml"), "utf8")).toContain("defaultOnStartup: true");
});

test("reap closes the recorded terminal by identity and is not offered twice", async () => {
  const t = await setup({ contacts: [contact("a", { lane: lane("/wt/a", "t1") })] });
  await t.act({ op: "lab", contact: "a", action: "reap", args: {} });
  expect(t.fake.calls.find((c) => c.method === "close")?.args).toEqual({ t: { handle: "t1", incarnationId: "t1-inc" }, w: "/wt/a" });
  expect((await t.events()).slice(-2)).toEqual(["reaped", "operator:reap:true"]);
  t.fake.world.fail.set("frontend.close", new Error("should not be called again"));
  const again = await t.reject(t.act({ op: "lab", contact: "a", action: "reap", args: {} }));
  expect(again.message).toBe("already reaped");
});

test("a frontend that no longer knows the terminal still reaps", async () => {
  const t = await setup({ contacts: [contact("a", { lane: lane("/wt/a", "t1") })] });
  t.fake.world.fail.set("frontend.close", new PortError("terminal-missing", "terminal t1 is gone"));
  await t.act({ op: "lab", contact: "a", action: "reap", args: {} });
  const events = await readEvents(t.home, "lab");
  expect(events.slice(-2)).toEqual([
    expect.objectContaining({ kind: "reaped" }),
    expect.objectContaining({ kind: "operator", op: "reap", ok: true }),
  ]);
});

test("an unknown action is refused", async () => {
  const t = await setup();
  expect((await t.reject(t.act({ op: "lab", contact: "a", action: "teleport", args: {} }))).status).toBe(404);
});
test("explicit model override is persisted for the mission's replacement pane", async () => {
  const t = await setup({}, {
    settings: async () => ({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, model: "global-model", mission: "mission-default", thinking: "high" },
    }),
  });
  t.readyChild();
  await t.act({ op: "lab", contact: "a", action: "launch", args: { model: "override-model" } });
  const op = await readOperation(t.home, "lab");
  expect(op.contacts[0].lane?.model).toBe("override-model");
});

test("explicit OMP default is persisted without becoming an inherited model", async () => {
  const t = await setup({}, {
    settings: async () => ({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, model: "global-model", mission: "mission-default" },
    }),
  });
  t.readyChild();
  await t.act({ op: "lab", contact: "a", action: "launch", args: { model: null } });
  const op = await readOperation(t.home, "lab");
  expect(op.contacts[0].lane?.model).toBeNull();
});

test("malformed model argument in launch and decide-agent is rejected with 400", async () => {
  const t = await setup();
  const badLaunch = await t.reject(t.act({ op: "lab", contact: "a", action: "launch", args: { model: 123 } }));
  expect(badLaunch).toMatchObject({ status: 400, code: "bad-request" });
  const badDecide = await t.reject(t.act({ op: "lab", contact: "n", action: "decide-agent", args: { model: true } }));
  expect(badDecide).toMatchObject({ status: 400, code: "bad-request" });
});
