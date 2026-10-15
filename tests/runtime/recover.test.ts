import { afterEach, describe, expect, test } from "bun:test";
import type { ContactStatus, Event, Owner, TerminalRef } from "../../src/core/types.ts";
import type { Run } from "../../src/ports.ts";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { createRecover } from "../../src/runtime/recover.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { loadProjection } from "../../src/snapshot.ts";
import { appendEvent, readEvents } from "../../src/store/events.ts";
import { contact, fakePorts, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

const T = Date.parse("2026-01-01T03:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SOCK = { socket: "/s.sock", generation: 1 };

interface Opts {
  recover?: boolean;
  cap?: number;
  /** Live omp count the cap is checked against. */
  open?: number;
  frontend?: "orca" | "none";
  contacts?: ReturnType<typeof contact>[];
  availableMemory?(): number | null;
}

/** Real action runner + real recovery over fake ports; the test plays the watcher by setting statuses, sockets and vanished panes. */
async function setup(opts: Opts = {}) {
  const home = tempDir("recover", dirs);
  await seedOperation(home, {
    recover: opts.recover ?? true,
    frontend: opts.frontend ?? "orca",
    contacts: opts.contacts ?? [contact("a", { lane: lane("/wt/a", "t1") })],
  });
  const fake = fakePorts();
  // Fresh handles per open, like a real frontend; the fake's constant handle would trip the relaunch guard.
  let opened = 0;
  fake.ports.frontend.openTerminal = async (i) => {
    fake.calls.push({ port: "frontend", method: "openTerminal", args: i });
    opened += 1;
    // The new child re-attaches the saved mission under resume hold and opens its control socket.
    const ctl = { socket: `/new-${opened}.sock`, generation: 100 + opened };
    fake.world.statuses.set(i.worktree, status({ worktree: i.worktree, ctl, hold: "resume", actions: ["continue"] }));
    fake.world.alive.add(ctl.socket);
    return { handle: `new-${opened}`, incarnationId: `new-${opened}-inc` } satisfies TerminalRef;
  };

  const statuses: Record<string, ContactStatus | null> = {};
  const vanished = new Set<string>();
  let now = T;

  const owners = (): Record<string, Owner> => {
    const out: Record<string, Owner> = {};
    for (const [ticket, s] of Object.entries(statuses)) {
      if (vanished.has(ticket)) out[ticket] = "offline";
      else if (s?.ctl) out[ticket] = fake.world.alive.has(s.ctl.socket) ? "live" : "offline";
      else out[ticket] = "none";
    }
    return out;
  };
  const settings = async () => ({ ...DEFAULT_SETTINGS, cap: opts.cap ?? 8 });
  const extras = () => ({ statuses, owners: owners(), probes: {}, load: { live: opts.open ?? 1, open: opts.open ?? 1 }, vanished, decisionPanes: new Set<string>(), integrationDirty: null });

  const noRun: Run = async () => ({ stdout: "", stderr: "", code: 0 });
  const availableMemory = opts.availableMemory ?? (() => 8 * 1024 * 1024 * 1024);
  const act = createActionRunner({
    home,
    now: () => new Date(now),
    settings,
    portsFor: () => fake.ports,
    extras,
    sleep: async () => {},
    token: () => "abc123",
    socketWaitMs: 0,
    run: noRun,
    availableMemory,
  });
  const warnings: string[] = [];
  const newRecover = () => createRecover({ home, now: () => new Date(now), settings, extras, run: act, warn: (m) => warnings.push(m), availableMemory });
  const recover = newRecover();

  const events = () => readEvents(home, "lab");
  const operator = async (op: string) =>
    (await events()).filter((e): e is Extract<Event, { kind: "operator" }> => e.kind === "operator" && e.op === op);
  /**
   * Relaunch is fire-and-forget and writes through the file system, so waits are bounded by wall time:
   * a loaded machine (the full suite) can need far more loop turns for the same I/O.
   */
  const until = async (done: () => boolean | Promise<boolean>, ms = 3_000) => {
    const deadline = performance.now() + ms;
    while (!(await done()) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  };
  /** Negative checks: give anything in flight a fixed window to (wrongly) happen. */
  const settle = () => until(async () => false, 150);
  const relaunches = async () => (await operator("relaunch")).filter((e) => e.by === "recover");

  /** Session state as the watcher would report it. */
  const live = (ticket: string, over: Partial<ContactStatus> = {}) => {
    const s = status({ ticket, worktree: `/wt/${ticket}`, ctl: SOCK, ...over });
    statuses[ticket] = s;
    fake.world.statuses.set(s.worktree, s);
    fake.world.alive.add(SOCK.socket);
  };
  const dead = (ticket: string, over: Partial<ContactStatus> = {}) => {
    statuses[ticket] = status({ ticket, worktree: `/wt/${ticket}`, ctl: SOCK, ...over });
    fake.world.alive.delete(SOCK.socket);
  };
  const ev = (kind: "socket-up" | "socket-down", at: number): Promise<void> =>
    appendEvent(home, "lab", kind === "socket-up" ? { v: 1, at: iso(at), kind, contact: "a", generation: 1 } : { v: 1, at: iso(at), kind, contact: "a" });

  return { home, fake, recover, newRecover, act, events, operator, relaunches, until, settle, live, dead, ev, vanished, warnings, advance: (ms: number) => (now += ms), now: () => now, extras, settings };
}

const resume = { hold: "resume" as const, actions: ["continue"] };
const controls = (t: Awaited<ReturnType<typeof setup>>) => t.fake.calls.filter((c) => c.port === "fleet" && c.method === "control");

describe("recovery: resume hold", () => {
  test("continues a live board-launched session holding at resume, credited to recover", async () => {
    const t = await setup();
    t.live("a", { ...resume, verify: "passed" });
    await t.recover.pass();
    expect(controls(t)).toHaveLength(1);
    expect(controls(t)[0]?.args).toMatchObject({ op: "continue" });
    expect(await t.operator("continue")).toMatchObject([{ contact: "a", ok: true, by: "recover" }]);
  });

  test.each([
    ["verify failed", { ...resume, verify: "failed" as const }, {}],
    ["no control socket", { ...resume, ctl: null }, {}],
    ["recover off", { ...resume }, { recover: false }],
    ["continue not offered", { hold: "resume" as const, actions: [] }, {}],
    ["quota hold", { hold: "quota" as const, actions: ["continue"] }, {}],
    ["not at resume hold", { hold: "gate" as const, actions: ["continue", "approve"] }, {}],
  ])("does not continue: %s", async (_name, over, opts) => {
    const t = await setup(opts);
    t.live("a", over);
    await t.recover.pass();
    expect(controls(t)).toHaveLength(0);
    expect(await t.operator("continue")).toEqual([]);
  });

  test("does not continue while the owner is offline", async () => {
    const t = await setup();
    t.dead("a");
    statuses_resume(t);
    await t.recover.pass();
    expect(controls(t)).toHaveLength(0);
  });

  test("a failed continue is recorded and not retried for 30 s, then retried once", async () => {
    const t = await setup();
    t.live("a", resume);
    t.fake.world.fail.set("fleet.control", new Error("ELOCKED: lock held by a stale session"));
    await t.recover.pass();
    expect(await t.operator("continue")).toMatchObject([{ ok: false, by: "recover" }]);

    t.advance(29_000);
    await t.recover.pass();
    expect(controls(t)).toHaveLength(1);

    t.advance(2_000);
    await t.recover.pass();
    expect(controls(t)).toHaveLength(2);
    expect(await t.operator("continue")).toHaveLength(2);
  });

  test("pacing survives a board restart: a fresh recover reads it from the events", async () => {
    const t = await setup();
    t.live("a", resume);
    t.fake.world.fail.set("fleet.control", new Error("ELOCKED"));
    await t.recover.pass();
    expect(controls(t)).toHaveLength(1);

    const restarted = t.newRecover();
    t.advance(10_000);
    await restarted.pass();
    expect(controls(t)).toHaveLength(1);

    t.advance(21_000);
    await restarted.pass();
    expect(controls(t)).toHaveLength(2);
  });
});

/** Resume hold on a status whose socket is dead (the helper `dead` leaves hold at "none"). */
function statuses_resume(t: Awaited<ReturnType<typeof setup>>) {
  t.extras().statuses.a = status({ ticket: "a", worktree: "/wt/a", ctl: SOCK, ...resume });
}

describe("recovery: relaunch", () => {
  test("relaunches a pane the frontend stopped listing, without closing it, in the same worktree", async () => {
    const t = await setup();
    t.fake.world.terminals = [];
    t.dead("a");
    t.vanished.add("a");
    await t.ev("socket-up", T - 5 * MIN);
    await t.recover.pass();
    await t.until(async () => (await t.operator("relaunch")).length > 0);

    expect(t.fake.count("frontend.close")).toBe(0);
    const open = t.fake.calls.find((c) => c.method === "openTerminal")?.args as { worktree: string; env: Record<string, string> };
    expect(open.worktree).toBe("/wt/a");
    expect(open.env).toEqual({ FAKE_LAUNCH: "a" });
    expect(await t.relaunches()).toMatchObject([{ contact: "a", ok: true, by: "recover" }]);
    expect((await t.events()).filter((e) => e.kind === "launched")).toHaveLength(2);
  });

  test.each(["quota", "question"] as const)("does not relaunch a vanished pane at an operator %s hold", async (hold) => {
    const t = await setup();
    t.fake.world.terminals = [];
    t.dead("a", { hold });
    t.vanished.add("a");
    await t.ev("socket-up", T - 5 * MIN);
    await t.recover.pass();
    await t.settle();
    expect(t.fake.count("frontend.openTerminal")).toBe(0);
    expect(await t.relaunches()).toEqual([]);
  });

  test("a relaunch queued behind another rechecks quota and does not open that pane", async () => {
    const t = await setup({
      contacts: [contact("a", { lane: lane("/wt/a", "t1") }), contact("b", { lane: lane("/wt/b", "t2") })],
    });
    t.fake.world.terminals = [];
    t.dead("a");
    t.dead("b");
    t.vanished.add("a");
    t.vanished.add("b");
    await t.ev("socket-up", T - 5 * MIN);
    const open = t.fake.ports.frontend.openTerminal;
    t.fake.ports.frontend.openTerminal = async (input) => {
      if (input && typeof input === "object" && "worktree" in input && input.worktree === "/wt/a") t.live("b", { hold: "quota" });
      return open(input);
    };
    await t.recover.pass();
    await t.until(async () => (await t.relaunches()).some(e => e.ok));
    await t.settle();
    const opened = t.fake.calls.filter((call) => call.method === "openTerminal").map((call) => {
      const args = call.args;
      return args && typeof args === "object" && "worktree" in args && typeof args.worktree === "string" ? args.worktree : "";
    });
    expect(opened).toEqual(["/wt/a"]);
  });

  test("relaunches after 60 s of socket-down with the pane still listed, closing the old one first", async () => {
    const t = await setup();
    t.fake.world.terminals = [{ handle: "t1", incarnationId: "t1-inc", worktree: "/wt/a", connected: true }];
    t.dead("a");
    await t.ev("socket-up", T - 10 * MIN);
    await t.ev("socket-down", T - 61_000);
    await t.recover.pass();
    await t.until(async () => (await t.operator("relaunch")).length > 0);

    const order = t.fake.calls.filter((c) => c.method === "close" || c.method === "openTerminal").map((c) => c.method);
    expect(order).toEqual(["close", "openTerminal"]);
    expect(await t.relaunches()).toMatchObject([{ ok: true, by: "recover" }]);
  });

  test("does not relaunch a listed pane whose socket went down less than 60 s ago", async () => {
    const t = await setup();
    t.fake.world.terminals = [{ handle: "t1", incarnationId: "t1-inc", worktree: "/wt/a", connected: true }];
    t.dead("a");
    await t.ev("socket-up", T - 10 * MIN);
    await t.ev("socket-down", T - 59_000);
    await t.recover.pass();
    await t.settle();
    expect(t.fake.count("frontend.openTerminal")).toBe(0);
  });

  test("does not relaunch with recover off, for a complete mission, or for a lane with no terminal", async () => {
    const off = await setup({ recover: false });
    off.fake.world.terminals = [];
    off.dead("a");
    off.vanished.add("a");
    await off.ev("socket-up", T - MIN);
    await off.recover.pass();
    await off.settle();
    expect(off.fake.count("frontend.openTerminal")).toBe(0);

    const done = await setup();
    done.live("a", { complete: true, phase: "complete" });
    done.fake.world.alive.delete(SOCK.socket);
    done.vanished.add("a");
    await done.ev("socket-up", T - MIN);
    await done.recover.pass();
    await done.settle();
    expect(done.fake.count("frontend.openTerminal")).toBe(0);

    const queued = await setup({ contacts: [contact("a", { lane: lane("/wt/a", null) })] });
    queued.dead("a");
    queued.vanished.add("a");
    await queued.recover.pass();
    await queued.settle();
    expect(queued.fake.count("frontend.openTerminal")).toBe(0);
  });

  test("never relaunches after an operator Reap; the operator's own Relaunch brings recovery back", async () => {
    const t = await setup();
    t.fake.world.terminals = [{ handle: "t1", incarnationId: "t1-inc", worktree: "/wt/a", connected: true }];
    t.live("a");
    await t.ev("socket-up", T - 10 * MIN);

    await t.act({ op: "lab", contact: "a", action: "reap", args: {} });
    // The pane is gone and the session dead: exactly what recovery would normally fix.
    t.fake.world.terminals = [];
    t.dead("a");
    t.vanished.add("a");
    t.advance(5 * MIN);
    await t.recover.pass();
    await t.settle();
    expect(t.fake.count("frontend.openTerminal")).toBe(0);
    expect(await t.relaunches()).toEqual([]);

    await t.act({ op: "lab", contact: "a", action: "relaunch", args: {} });
    expect(t.fake.count("frontend.openTerminal")).toBe(1);
    expect((await t.operator("relaunch")).at(-1)).toMatchObject({ ok: true });
    expect((await t.operator("relaunch")).at(-1)?.by).toBeUndefined();

    // The new pane dies too; recovery handles it again.
    t.advance(MIN);
    t.dead("a");
    t.vanished.add("a");
    await t.recover.pass();
    await t.until(async () => (await t.relaunches()).length > 0);
    expect(t.fake.count("frontend.openTerminal")).toBe(2);
  });

  test("a mission past its plan relaunches outside plan mode so continue is allowed; one still planning reopens in it", async () => {
    const overlayOf = (t: Awaited<ReturnType<typeof setup>>) =>
      String((t.fake.calls.find((c) => c.method === "launch")?.args as { overlay?: string } | undefined)?.overlay);
    for (const [phase, overlay] of [["graph", "resume.yml"], ["plan", "plan-default.yml"]] as const) {
      const t = await setup();
      t.fake.world.terminals = [];
      t.dead("a");
      t.fake.world.statuses.set("/wt/a", status({ phase, ctl: null }));
      t.vanished.add("a");
      await t.act({ op: "lab", contact: "a", action: "relaunch", args: {} });
      expect(overlayOf(t).endsWith(`/launch/${overlay}`)).toBe(true);
    }
  });

  test("a relaunched session at resume hold is continued by the next pass", async () => {
    const t = await setup();
    t.fake.world.terminals = [];
    t.dead("a");
    t.vanished.add("a");
    await t.ev("socket-up", T - MIN);
    await t.recover.pass();
    await t.until(async () => (await t.operator("relaunch")).length > 0);

    // New child attached the saved mission under resume hold.
    t.vanished.delete("a");
    t.advance(2_000);
    t.live("a", resume);
    await t.recover.pass();
    expect((await t.operator("continue")).map((e) => e.by)).toEqual(["recover"]);
    expect(controls(t)).toHaveLength(1);
  });
});

describe("recovery: crash-loop guard", () => {
  /**
   * One pass that vanishes the pane, then waits for the new pane open (bounded: a
   * gave-up pass never opens) and settles so the fire-and-forget act finishes.
   */
  async function crash(t: Awaited<ReturnType<typeof setup>>, opens: number) {
    t.fake.world.terminals = [];
    t.dead("a");
    t.vanished.add("a");
    await t.recover.pass();
    // Up to the budget a relaunch is expected: wait for its recorded result. Past it nothing may open.
    if (opens <= 3) await t.until(async () => (await t.relaunches()).filter((e) => e.ok).length >= opens);
    await t.settle();
    t.advance(MIN);
  }
  const gaveUp = async (t: Awaited<ReturnType<typeof setup>>) =>
    (await t.operator("relaunch")).filter((e) => e.ok === false && e.error?.startsWith("gave up:"));

  test("three relaunches, then exactly one `gave up` event and nothing more", async () => {
    const t = await setup();
    await t.ev("socket-up", T - MIN);
    for (let i = 1; i <= 3; i += 1) await crash(t, i);
    expect(t.fake.count("frontend.openTerminal")).toBe(3);
    expect(await gaveUp(t)).toEqual([]);

    for (let i = 0; i < 4; i += 1) await crash(t, 4);
    expect(t.fake.count("frontend.openTerminal")).toBe(3);
    const gave = await gaveUp(t);
    expect(gave).toHaveLength(1);
    expect(gave[0]).toMatchObject({ contact: "a", by: "recover", error: "gave up: 3 relaunches in 30 min" });
  });

  test("an operator Relaunch resets the count", async () => {
    const t = await setup();
    await t.ev("socket-up", T - MIN);
    for (let i = 1; i <= 3; i += 1) await crash(t, i);
    await crash(t, 4);
    await t.until(async () => (await gaveUp(t)).length > 0);
    expect(await gaveUp(t)).toHaveLength(1);

    await t.act({ op: "lab", contact: "a", action: "relaunch", args: {} });
    t.advance(MIN);
    expect(t.fake.count("frontend.openTerminal")).toBe(4);

    await crash(t, 5);
    expect(t.fake.count("frontend.openTerminal")).toBe(5);
    expect(await gaveUp(t)).toHaveLength(1);
  });

  test("relaunches older than 30 min no longer count", async () => {
    const t = await setup();
    await t.ev("socket-up", T - MIN);
    for (let i = 1; i <= 3; i += 1) await crash(t, i);
    t.advance(31 * MIN);
    await crash(t, 4);
    expect(t.fake.count("frontend.openTerminal")).toBe(4);
    expect(await gaveUp(t)).toEqual([]);
  });

  test("a fresh launched/socket-up blocks relaunch on a stale vanished mark", async () => {
    const t = await setup();
    await t.ev("socket-up", T - MIN);
    await appendEvent(t.home, "lab", { v: 1, at: iso(T - 30_000), kind: "launched", contact: "a", worktree: "/wt/a", frontend: "orca", terminal: { handle: "t9", incarnationId: "i9" } });
    t.fake.world.terminals = [];
    t.dead("a");
    t.vanished.add("a");
    await t.recover.pass();
    await t.settle();
    expect(t.fake.count("frontend.openTerminal")).toBe(0);
    // Once the freshness window passes, the same mark relaunches.
    t.advance(MIN);
    await t.recover.pass();
    await t.until(async () => t.fake.count("frontend.openTerminal") >= 1, 2_000);
    expect(t.fake.count("frontend.openTerminal")).toBe(1);
  });
});

describe("recovery: cap", () => {
  test("a full cap makes no attempt and writes no event", async () => {
    const t = await setup({ cap: 1, open: 1 });
    t.fake.world.terminals = [];
    t.dead("a");
    t.vanished.add("a");
    await t.ev("socket-up", T - MIN);
    const before = (await t.events()).length;
    await t.recover.pass();
    await t.settle();
    expect(t.fake.count("frontend.openTerminal")).toBe(0);
    expect((await t.events()).length).toBe(before);
  });
});

describe("Relaunch button legality", () => {
  const view = async (t: Awaited<ReturnType<typeof setup>>, ticket = "a") =>
    (await loadProjection(t.home, "lab", await t.settings(), t.now(), t.extras())).contacts.find((c) => c.ticket === ticket)?.actions.find((a) => a.id === "relaunch");

  test("offered and enabled on an offline contact whose lane has a terminal", async () => {
    const t = await setup();
    t.dead("a");
    t.vanished.add("a");
    expect(await view(t)).toMatchObject({ id: "relaunch", label: "Relaunch", enabled: true, reason: null });
  });

  test("not offered while the session is live, once complete, without a terminal, on external lanes or with no frontend", async () => {
    const live = await setup();
    live.live("a");
    expect(await view(live)).toBeUndefined();

    const done = await setup();
    done.live("a", { complete: true, phase: "complete" });
    expect(await view(done)).toBeUndefined();

    const noTerminal = await setup({ contacts: [contact("a", { lane: lane("/wt/a", null) })] });
    noTerminal.dead("a");
    expect(await view(noTerminal)).toBeUndefined();

    const external = await setup({ contacts: [contact("a", { lane: { worktree: "/wt/a", branch: null, frontend: "external", terminal: null } })] });
    external.dead("a");
    expect(await view(external)).toBeUndefined();

    const none = await setup({ frontend: "none" });
    none.dead("a");
    none.vanished.add("a");
    expect(await view(none)).toBeUndefined();
  });

  test("a reaped contact is offered Relaunch", async () => {
    const t = await setup();
    t.live("a");
    await t.act({ op: "lab", contact: "a", action: "reap", args: {} });
    expect(await view(t)).toMatchObject({ enabled: true });
  });

  test("disabled with the cap reason when the cap is full, and the action refuses", async () => {
    const t = await setup({ cap: 2, open: 2 });
    t.dead("a");
    t.vanished.add("a");
    expect(await view(t)).toMatchObject({ enabled: false, reason: "cap 2/2 omp" });
    await expect(t.act({ op: "lab", contact: "a", action: "relaunch", args: {} })).rejects.toMatchObject({ status: 409 });
    expect(t.fake.count("frontend.openTerminal")).toBe(0);
    expect(await t.operator("relaunch")).toMatchObject([{ ok: false }]);
  });
});

test("manual relaunch under memory pressure preserves its old terminal and saved lane", async () => {
  const t = await setup({ availableMemory: () => 100 * 1024 * 1024 });
  t.dead("a");
  t.vanished.add("a");
  const before = await loadProjection(t.home, "lab", await t.settings(), t.now(), t.extras());
  await expect(t.act({ op: "lab", contact: "a", action: "relaunch", args: {} }))
    .rejects.toMatchObject({ code: "memory-pressure" });
  const after = await loadProjection(t.home, "lab", await t.settings(), t.now(), t.extras());
  expect(after.contacts[0]?.lane).toEqual(before.contacts[0]?.lane);
  expect(t.fake.count("frontend.closeTerminal")).toBe(0);
  expect(t.fake.count("frontend.openTerminal")).toBe(0);
});

test("memory pressure defers recovery without spending the crash-loop budget", async () => {
  let available = 100 * 1024 * 1024;
  const t = await setup({ availableMemory: () => available });
  t.dead("a");
  t.vanished.add("a");
  await t.ev("socket-up", T - 5 * MIN);
  for (let attempt = 0; attempt < 4; attempt++) await t.recover.pass();
  await t.settle();
  expect(await t.relaunches()).toEqual([]);
  expect(t.fake.count("frontend.openTerminal")).toBe(0);
  expect(t.recover.deferred("lab").a?.kind).toBe("memory");
  // Headroom can disappear after the queue check; persisted refusals aren't crashes.
  for (let attempt = 0; attempt < 3; attempt++) {
    await appendEvent(t.home, "lab", {
      v: 1, at: iso(T - 3 + attempt), kind: "operator", contact: "a",
      op: "relaunch", by: "recover", ok: false, error: "memory-pressure: insufficient memory",
    });
  }
  available = 1200 * 1024 * 1024;
  await t.recover.pass();
  await t.until(async () => (await t.relaunches()).length === 4);
  expect((await t.relaunches()).at(-1)?.ok).toBe(true);
});

test("a recovery batch reserves its last slot and starts the waiting mission after capacity returns", async () => {
  const opts = { cap: 2, open: 1, contacts: [contact("a", { lane: lane("/wt/a", "t1") }), contact("b", { lane: lane("/wt/b", "t2") })] };
  const t = await setup(opts);
  t.dead("a");
  t.dead("b");
  t.vanished.add("a");
  t.vanished.add("b");
  await t.recover.pass();
  await t.until(async () => (await t.relaunches()).length === 1);
  expect(t.fake.count("frontend.openTerminal")).toBe(1);
  expect(t.recover.deferred("lab").b?.kind).toBe("capacity");
  t.live("a");
  t.vanished.delete("a");
  await t.recover.pass();
  await t.until(async () => (await t.relaunches()).length === 2);
  expect(t.fake.count("frontend.openTerminal")).toBe(2);
  expect((await t.relaunches()).every(e => e.ok)).toBe(true);
});

test("waiting for memory is canceled by a producer quota park or operator Reap", async () => {
  const t = await setup({ availableMemory: () => 100 * 1024 * 1024 });
  t.dead("a");
  t.vanished.add("a");
  await t.recover.pass();
  expect(t.recover.deferred("lab").a?.kind).toBe("memory");
  t.dead("a", { hold: "quota" });
  await t.recover.pass();
  expect(t.recover.deferred("lab").a).toBeUndefined();
  t.dead("a");
  await t.recover.pass();
  await t.act({ op: "lab", contact: "a", action: "reap", args: {} });
  await t.recover.pass();
  expect(t.recover.deferred("lab").a).toBeUndefined();
  expect(t.fake.count("frontend.openTerminal")).toBe(0);
});

test("automatic Continue rechecks a producer quota park even when the watcher still shows resume", async () => {
  const t = await setup();
  t.live("a", resume);
  t.fake.world.statuses.set("/wt/a", status({ ctl: SOCK, hold: "quota", actions: ["continue"] }));
  await expect(t.act({ op: "lab", contact: "a", action: "continue", args: {}, by: "recover" }))
    .rejects.toMatchObject({ code: "refused" });
  expect(controls(t)).toEqual([]);
});
