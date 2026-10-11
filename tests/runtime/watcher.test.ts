import { afterEach, expect, test } from "bun:test";
import { createWatcher } from "../../src/runtime/watcher.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { writeDecisionPane } from "../../src/store/decisions.ts";
import { appendEvent, readEvents } from "../../src/store/events.ts";
import { contact, fakePorts, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

async function setup(over: { sampleMs?: number } = {}) {
  const home = tempDir("watch", dirs);
  await seedOperation(home, {
    tracker: "linear",
    contacts: [contact("CHR-1", { lane: lane("/wt/a", "t1", "feat/a") }), contact("CHR-2"), contact("CHR-3", { lane: lane("/wt/z", "t2") })],
  });
  const fake = fakePorts();
  fake.world.statuses.set("/wt/a", status());
  fake.world.statuses.set("/wt/z", status({ id: "run-z", worktree: "/wt/z", ctl: null }));
  fake.world.alive.add("/tmp/x.sock");
  const warnings: string[] = [];
  let now = Date.parse("2026-01-01T00:10:00Z");
  const make = () =>
    createWatcher({
      home,
      now: () => new Date(now),
      settings: async () => ({ ...DEFAULT_SETTINGS, sampleMs: over.sampleMs ?? 60_000 }),
      portsFor: () => fake.ports,
      warn: (m) => warnings.push(m),
    });
  const watcher = make();
  const kinds = async (ticket: string) =>
    (await readEvents(home, "lab")).filter((e) => "contact" in e && e.contact === ticket).map((e) => e.kind);
  return { home, fake, watcher, make, warnings, kinds, tick: (ms: number) => void (now += ms) };
}

test("one phase, gate and socket-up event per change, however many passes run", async () => {
  const { watcher, fake, kinds } = await setup();
  await watcher.pass();
  await watcher.pass();
  expect(await kinds("CHR-1")).toEqual(["queued", "launched", "phase", "socket-up"]);
  fake.world.statuses.set("/wt/a", status({ phase: "execute", gate: { kind: "pause", id: "abc123" }, hold: "gate" }));
  await watcher.pass();
  await watcher.pass();
  expect(await kinds("CHR-1")).toEqual(["queued", "launched", "phase", "socket-up", "phase", "gate-armed"]);
});

test("a restart replays nothing: state is seeded from the events", async () => {
  const { watcher, make, kinds } = await setup();
  await watcher.pass();
  const before = await kinds("CHR-1");
  await make().pass();
  expect(await kinds("CHR-1")).toEqual(before);
});

test("owner loss records socket-down once; a new generation is down then up", async () => {
  const { watcher, fake, kinds } = await setup();
  await watcher.pass();
  fake.world.alive.clear();
  await watcher.pass();
  await watcher.pass();
  expect(await kinds("CHR-1")).toEqual(["queued", "launched", "phase", "socket-up", "socket-down"]);
  expect(watcher.extras("lab").owners["CHR-1"]).toBe("offline");
  fake.world.alive.add("/tmp/x.sock");
  fake.world.statuses.set("/wt/a", status({ ctl: { socket: "/tmp/x.sock", generation: 200 } }));
  await watcher.pass();
  expect(await kinds("CHR-1")).toEqual(["queued", "launched", "phase", "socket-up", "socket-down", "socket-up"]);
  fake.world.statuses.set("/wt/a", status({ ctl: { socket: "/tmp/x.sock", generation: 300 } }));
  await watcher.pass();
  expect((await kinds("CHR-1")).slice(-2)).toEqual(["socket-down", "socket-up"]);
});

test("samples are appended only when a watched field changes", async () => {
  const { watcher, fake, kinds } = await setup({ sampleMs: 10_000 });
  fake.world.tracker.set("CHR-1", { state: "In Progress", url: "https://l/a" });
  await watcher.pass();
  await watcher.pass(null, true);
  expect((await kinds("CHR-1")).filter((k) => k === "sample")).toHaveLength(1);
  fake.world.tracker.set("CHR-1", { state: "Done", url: "https://l/a" });
  await watcher.pass(null, true);
  expect((await kinds("CHR-1")).filter((k) => k === "sample")).toHaveLength(2);
});

test("sampling waits for sampleMs unless forced", async () => {
  const { watcher, fake, tick } = await setup({ sampleMs: 60_000 });
  await watcher.pass();
  const first = fake.count("tracker.sample");
  expect(first).toBeGreaterThan(0);
  tick(5_000);
  await watcher.pass();
  expect(fake.count("tracker.sample")).toBe(first);
  tick(60_000);
  await watcher.pass();
  expect(fake.count("tracker.sample")).toBeGreaterThan(first);
  const before = fake.count("tracker.sample");
  await watcher.pass(null, true);
  expect(fake.count("tracker.sample")).toBeGreaterThan(before);
});

test("a delivery probe is overridden live and recorded in the sample", async () => {
  const { watcher, fake, home } = await setup();
  fake.world.statuses.set("/wt/a", status({ delivery: { url: "https://gh/pr/1", branch: "feat/a" } }));
  fake.world.probes.set("CHR-1", { url: "https://gh/pr/1", state: "open", mergeable: "clean", checks: "pass" });
  await watcher.pass();
  expect(watcher.extras("lab").probes["CHR-1"]?.mergeable).toBe("clean");
  const sample = (await readEvents(home, "lab")).find((e) => e.kind === "sample");
  expect(sample).toMatchObject({ contact: "CHR-1", delivery: { state: "open", checks: "pass" } });
});

test("a port failure is contained, warned once, and keeps the last known status", async () => {
  const { watcher, fake, warnings } = await setup();
  await watcher.pass();
  fake.world.fail.set("fleet.read", new Error("socket exploded"));
  await watcher.pass();
  await watcher.pass();
  expect(warnings).toEqual(["fleet read CHR-1: socket exploded", "fleet read CHR-3: socket exploded"]);
  expect(watcher.extras("lab").statuses["CHR-1"]?.phase).toBe("plan");
});

test("owners and load: queued contacts are never read; no-ctl status is owner none", async () => {
  const { watcher, fake } = await setup();
  await watcher.pass();
  expect(fake.calls.filter((c) => c.method === "read").map((c) => (c.args as { worktree: string }).worktree).sort()).toEqual(["/wt/a", "/wt/z"]);
  const extras = watcher.extras("lab");
  expect(extras.owners).toEqual({ "CHR-1": "live", "CHR-3": "none" });
  expect(extras.load).toEqual({ live: 2, open: 2 });
});

test("landed contacts are not watched any more", async () => {
  const { watcher, fake, home } = await setup();
  await appendEvent(home, "lab", { v: 1, at: "2026-01-01T00:05:00.000Z", kind: "landed", contact: "CHR-3", via: "manual" });
  await watcher.pass();
  expect(fake.calls.filter((c) => c.method === "read").map((c) => (c.args as { worktree: string }).worktree)).toEqual(["/wt/a"]);
});

test("load sums live terminals across every open operation, so one project cannot hide load", async () => {
  const { watcher, home } = await setup();
  await seedOperation(home, { id: "side", name: "Side", contacts: [contact("x", { lane: lane("/wt/x", "t9") })] });
  await watcher.pass();
  expect(watcher.extras("lab").load).toEqual({ live: 2, open: 3 });
  expect(watcher.extras("side").load).toEqual({ live: 1, open: 3 });
});

test("a terminal the frontend stops listing is offline and leaves the load count", async () => {
  const { watcher, fake } = await setup();
  fake.world.terminals = [{ handle: "t1", incarnationId: "t1-inc", worktree: "/wt/a", connected: true }];
  await watcher.pass();
  expect(watcher.extras("lab").owners).toEqual({ "CHR-1": "live", "CHR-3": "offline" });
  await watcher.pass();
  expect(watcher.extras("lab").load).toEqual({ live: 1, open: 1 });
});

test("a frontend that cannot list terminals leaves owners and load alone", async () => {
  const { watcher } = await setup();
  await watcher.pass();
  await watcher.pass();
  expect(watcher.extras("lab").load).toEqual({ live: 2, open: 2 });
});

test("queued contacts trigger no terminal listing", async () => {
  const home = tempDir("watchq", dirs);
  await seedOperation(home, { contacts: [contact("Q-1"), contact("Q-2")] });
  const fake = fakePorts();
  const watcher = createWatcher({ home, now: () => new Date("2026-01-01T00:00:00Z"), settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, warn: () => {} });
  await watcher.pass();
  expect(fake.count("frontend.listTerminals")).toBe(0);
  expect(watcher.extras("lab").load).toEqual({ live: 0, open: 0 });
});

test("completed work triggers no terminal listing", async () => {
  const home = tempDir("watchc", dirs);
  await seedOperation(home, { contacts: [contact("C-1", { lane: lane("/wt/c", "tc") })] });
  const fake = fakePorts();
  fake.world.terminals = [{ handle: "tc", incarnationId: "tc-inc", worktree: "/wt/c", connected: true }];
  const watcher = createWatcher({ home, now: () => new Date("2026-01-01T00:00:00Z"), settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, warn: () => {} });
  await appendEvent(home, "lab", { v: 1, at: "2026-01-01T00:00:00Z", kind: "landed", contact: "C-1", via: "manual" });
  await watcher.pass();
  expect(fake.count("frontend.listTerminals")).toBe(0);
  await appendEvent(home, "lab", { v: 1, at: "2026-01-01T00:01:00Z", kind: "reaped", contact: "C-1" });
  await watcher.pass();
  expect(fake.count("frontend.listTerminals")).toBe(0);
});

test("two orca operations share one terminal listing per pass", async () => {
  const home = tempDir("watchs", dirs);
  await seedOperation(home, { contacts: [contact("A-1", { lane: lane("/wt/a", "ta") })] });
  await seedOperation(home, { id: "op2", name: "Op2", contacts: [contact("B-1", { lane: lane("/wt/b", "tb") })] });
  const fake = fakePorts();
  fake.ports.frontend = { ...fake.ports.frontend, id: "orca" };
  fake.world.statuses.set("/wt/a", status({ id: "run-a", worktree: "/wt/a", ctl: { socket: "/tmp/a.sock", generation: 1 } }));
  fake.world.statuses.set("/wt/b", status({ id: "run-b", worktree: "/wt/b", ctl: { socket: "/tmp/b.sock", generation: 1 } }));
  fake.world.alive.add("/tmp/a.sock");
  fake.world.alive.add("/tmp/b.sock");
  fake.world.terminals = [
    { handle: "ta", incarnationId: "ta-inc", worktree: "/wt/a", connected: true },
    { handle: "tb", incarnationId: "tb-inc", worktree: "/wt/b", connected: true },
  ];
  const watcher = createWatcher({ home, now: () => new Date("2026-01-01T00:00:00Z"), settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, warn: () => {} });
  await watcher.pass();
  expect(fake.count("frontend.listTerminals")).toBe(1);
  expect(watcher.extras("lab").owners["A-1"]).toBe("live");
  expect(watcher.extras("op2").owners["B-1"]).toBe("live");
});

test("custom frontend does not share terminal listings", async () => {
  const home = tempDir("watchcust", dirs);
  await seedOperation(home, { contacts: [contact("A-1", { lane: lane("/wt/a", "ta") })] });
  await seedOperation(home, { id: "op2", name: "Op2", contacts: [contact("B-1", { lane: lane("/wt/b", "tb") })] });
  const fake = fakePorts();
  fake.ports.frontend = { ...fake.ports.frontend, id: "custom" };
  fake.world.terminals = [
    { handle: "ta", incarnationId: "ta-inc", worktree: "/wt/a", connected: true },
    { handle: "tb", incarnationId: "tb-inc", worktree: "/wt/b", connected: true },
  ];
  const watcher = createWatcher({ home, now: () => new Date("2026-01-01T00:00:00Z"), settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, warn: () => {} });
  await watcher.pass();
  expect(fake.count("frontend.listTerminals")).toBe(2);
});

test("live/offline transitions observed through shared listing; stale vanished cleared", async () => {
  const home = tempDir("watchv", dirs);
  await seedOperation(home, { contacts: [contact("V-1", { lane: lane("/wt/v", "tv") }), contact("V-2", { lane: lane("/wt/w", "tw") })] });
  const fake = fakePorts();
  fake.ports.frontend = { ...fake.ports.frontend, id: "orca" };
  fake.world.statuses.set("/wt/v", status({ id: "run-v", worktree: "/wt/v", ctl: { socket: "/tmp/v.sock", generation: 1 } }));
  fake.world.statuses.set("/wt/w", status({ id: "run-w", worktree: "/wt/w", ctl: { socket: "/tmp/w.sock", generation: 1 } }));
  fake.world.alive.add("/tmp/v.sock");
  fake.world.alive.add("/tmp/w.sock");
  fake.world.terminals = [
    { handle: "tv", incarnationId: "tv-inc", worktree: "/wt/v", connected: true },
    { handle: "tw", incarnationId: "tw-inc", worktree: "/wt/w", connected: true },
  ];
  const watcher = createWatcher({ home, now: () => new Date("2026-01-01T00:00:00Z"), settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, warn: () => {} });
  await watcher.pass();
  expect(watcher.extras("lab").owners["V-1"]).toBe("live");
  fake.world.terminals = [{ handle: "tv", incarnationId: "tv-inc", worktree: "/wt/v", connected: true }];
  await watcher.pass();
  expect(watcher.extras("lab").owners["V-2"]).toBe("offline");
  expect(watcher.extras("lab").vanished.has("V-2")).toBe(true);
  fake.world.terminals = [
    { handle: "tv", incarnationId: "tv-inc", worktree: "/wt/v", connected: true },
    { handle: "tw", incarnationId: "tw-inc", worktree: "/wt/w", connected: true },
  ];
  await watcher.pass();
  expect(watcher.extras("lab").vanished.has("V-2")).toBe(false);
});

test("decision panes trigger terminal listing when needed", async () => {
  const home = tempDir("watchd", dirs);
  await seedOperation(home, { contacts: [contact("D-1", { kind: "decision" })] });
  const fake = fakePorts();
  fake.ports.frontend = { ...fake.ports.frontend, id: "orca" };
  fake.world.terminals = [{ handle: "td", incarnationId: "td-inc", worktree: "/tmp/int", connected: true }];
  const watcher = createWatcher({ home, now: () => new Date("2026-01-01T00:00:00Z"), settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, warn: () => {} });
  await writeDecisionPane(home, "lab", "D-1", { terminal: { handle: "td", incarnationId: "td-inc" }, startedAt: "2026-01-01T00:00:00Z" });
  await watcher.pass();
  expect(fake.count("frontend.listTerminals")).toBe(1);
  fake.world.terminals = [];
  await watcher.pass();
  expect(fake.count("frontend.listTerminals")).toBe(2);
  const events = await readEvents(home, "lab");
  expect(events.some((e) => e.kind === "operator" && "error" in e && e.error === "pane closed before deciding")).toBe(true);
});
