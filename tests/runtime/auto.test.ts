import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ActionRequest } from "../../src/board.ts";
import type { AutoMode, ContactStatus, DeliveryProbe } from "../../src/core/types.ts";
import { PortError, type Run } from "../../src/ports.ts";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { createAuto } from "../../src/runtime/auto.ts";
import { ActionError } from "../../src/runtime/errors.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { readEvents } from "../../src/store/events.ts";
import { mutateOperation, readOperation } from "../../src/store/operations.ts";
import { contact, fakePorts, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

const AUTO: AutoMode = { enabled: true, launch: true, land: true, maxLive: 4, plans: false, decide: false };

/** Real action runner over fake ports; git never leaves the porcelain line dirty. */
async function setup(contacts: ReturnType<typeof contact>[], opts: {
  auto?: AutoMode;
  statuses?: Record<string, ContactStatus>;
  probes?: Record<string, DeliveryProbe>;
  load?: { live: number; open: number };
  fail?: Record<string, Error>;
  delivery?: "local-merge" | "none";
  integrationError?: PortError;
} = {}) {
  const home = tempDir("auto", dirs);
  await seedOperation(home, {
    frontend: "orca",
    fleet: "omp-mission",
    delivery: opts.delivery ?? "local-merge",
    integration: "/tmp/lab",
    auto: opts.auto ?? AUTO,
    contacts,
  });
  const fake = fakePorts();
  for (const [key, error] of Object.entries(opts.fail ?? {})) fake.world.fail.set(key, error);
  // The launcher's socket poll needs a live status at the worktree openTerminal just made.
  const statuses = new Map(Object.entries(opts.statuses ?? {}));
  const probes = new Map(Object.entries(opts.probes ?? {}));
  const run: Run = async () => ({ stdout: "", stderr: "", code: 0 });
  const act = createActionRunner({
    home,
    now: () => new Date("2026-01-01T03:00:00Z"),
    settings: async () => ({ ...DEFAULT_SETTINGS, cleanup: true }),
    portsFor: () => fake.ports,
    extras: () => ({
      statuses: Object.fromEntries(statuses),
      owners: {},
      probes: Object.fromEntries(probes),
      load: opts.load ?? { live: 0, open: 0 },
    }),
    sleep: async () => {},
    token: () => "abc123",
    socketWaitMs: 0,
    run: async () => ({ stdout: "", stderr: "", code: 0 }),
  });
  const warnings: string[] = [];
  let integrationError = opts.integrationError;
  let autoNow = Date.parse("2026-01-01T03:00:00Z");
  const auto = createAuto({
    home,
    now: () => new Date(autoNow),
    settings: async () => ({ ...DEFAULT_SETTINGS, cleanup: true }),
    extras: (opId) => ({
      statuses: Object.fromEntries(statuses),
      owners: Object.fromEntries([...statuses.keys()].map(k => [k, "live"])),
      probes: Object.fromEntries(probes),
      load: opts.load ?? { live: 0, open: 0 },
      vanished: new Set(),
      decisionPanes: new Set(),
    }),
    run: act,
    integrationReady: async () => { if (integrationError) throw integrationError; },
    warn: (m) => warnings.push(m),
  });
  const events = async () => readEvents(home, "lab");
  const op = () => readOperation(home, "lab");
  /** Mark a ticket's mission status for the next pass (extras) and the fleet read (world). */
  const setStatus = (ticket: string, s: ContactStatus) => {
    statuses.set(ticket, s);
    fake.world.statuses.set(s.worktree, s);
  };
  const setProbe = (ticket: string, p: DeliveryProbe) => probes.set(ticket, p);
  /** Feed the fake fleet the status a launched worktree will report. */
  const liveWorktree = (name: string, s?: Partial<ContactStatus>) => {
    const st = status({ worktree: `/wt/${name}`, ctl: { socket: `/sim/${name}.sock`, generation: 1 }, ...s });
    fake.world.statuses.set(`/wt/${name}`, st);
    fake.world.alive.add(`/sim/${name}.sock`);
    return st;
  };
  return { home, fake, auto, act, events, op, setStatus, setProbe, liveWorktree, warnings,
    setIntegrationError: (error?: PortError) => { integrationError = error; },
    advance: (ms: number) => { autoNow += ms; },
  };
}

describe("auto mode", () => {
  test("lands a complete contact then launches the next queued one", async () => {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") }), contact("b")]);
    t.setStatus("a", status({ worktree: "/wt/a", complete: true, phase: "complete", ctl: null }));
    t.setProbe("a", { url: "u", state: "open", mergeable: "clean", checks: "pass" });
    t.liveWorktree("b");

    await t.auto.pass();

    const events = await t.events();
    expect(events.filter((e) => e.kind === "landed").map((e) => ("contact" in e ? e.contact : ""))).toEqual(["a"]);
    expect(events.find((e) => e.kind === "launched" && "contact" in e && e.contact === "b")).toBeTruthy();
    // Actions were taken by the board, recorded with by: "auto".
    const operator = events.filter((e) => e.kind === "operator");
    expect(operator.map((e) => (e.kind === "operator" ? `${e.op}:${e.by ?? "operator"}` : ""))).toEqual(
      expect.arrayContaining(["land:auto", "launch:auto"]),
    );
    expect((await t.op()).auto?.enabled).toBe(true);
  });

  test("respects maxLive: no launch while the operation is at its own ceiling", async () => {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") }), contact("b")], {
      auto: { enabled: true, launch: true, land: true, maxLive: 1, plans: false, decide: false },
      load: { live: 1, open: 1 },
    });
    t.setStatus("a", status({ worktree: "/wt/a", phase: "execute", ctl: null }));

    await t.auto.pass();
    expect(t.fake.count("fleet.launch")).toBe(0);
    expect((await t.events()).some((e) => e.kind === "launched" && "contact" in e && e.contact === "b")).toBe(false);
  });

  test("respects the global cap even below maxLive", async () => {
    const t = await setup([contact("b")], { load: { live: 3, open: 8 } });
    await t.auto.pass();
    expect(t.fake.count("frontend.createWorkspace")).toBe(0);
  });

  test("a failed action pauses auto with the reason and does not launch", async () => {
    const t = await setup([contact("b")], { fail: { "frontend.createWorkspace": new PortError("orca-down", "orca exploded") } });
    await t.auto.pass();
    const op = await t.op();
    expect(op.auto?.enabled).toBe(false);
    const auto = (await t.events()).find((e) => e.kind === "auto");
    expect(auto).toMatchObject({ kind: "auto", enabled: false, by: "board" });
    expect(auto && "reason" in auto ? auto.reason : "").toContain("orca exploded");
  });

  test("dirty integration waits without turning auto off or repeatedly landing; queue still launches", async () => {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") }), contact("b")], {
      integrationError: new PortError("integration-dirty", "integration worktree has uncommitted changes"),
    });
    t.setStatus("a", status({ worktree: "/wt/a", complete: true, phase: "complete", ctl: null }));
    t.setProbe("a", { url: "u", state: "open", mergeable: "clean", checks: "pass" });
    t.liveWorktree("b");
    await t.auto.pass();
    await t.auto.pass();
    expect((await t.op()).auto?.enabled).toBe(true);
    expect((await t.events()).filter(e => e.kind === "operator" && e.op === "land")).toEqual([]);
    expect((await t.events()).some(e => e.kind === "launched" && e.contact === "b")).toBe(true);
    expect((await t.events()).some(e => e.kind === "auto" && !e.enabled)).toBe(false);
    expect(t.auto.landingWait("lab")).toContain("uncommitted changes");
    t.setIntegrationError();
    t.advance(30_001);
    await t.auto.pass();
    expect((await t.events()).some(e => e.kind === "landed" && e.contact === "a")).toBe(true);
    expect(t.auto.landingWait("lab")).toBeNull();
  });

  test("integration changing after preflight defers landing instead of disabling auto", async () => {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
      fail: { "delivery.land": new PortError("integration-dirty", "integration worktree has uncommitted changes") },
    });
    t.setStatus("a", status({ worktree: "/wt/a", complete: true, phase: "complete", ctl: null }));
    t.setProbe("a", { url: "u", state: "open", mergeable: "clean", checks: "pass" });
    await t.auto.pass();
    await t.auto.pass();
    expect((await t.op()).auto?.enabled).toBe(true);
    expect(t.fake.count("delivery.land")).toBe(1);
    t.fake.world.fail.delete("delivery.land");
    t.advance(30_001);
    await t.auto.pass();
    expect((await t.events()).some(e => e.kind === "landed" && e.contact === "a")).toBe(true);
  });

  test("wrong integration branch waits and disabling auto clears the wait", async () => {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
      integrationError: new PortError("integration-wrong-branch", "integration is on topic, expected main"),
    });
    t.setStatus("a", status({ worktree: "/wt/a", complete: true, phase: "complete", ctl: null }));
    t.setProbe("a", { url: "u", state: "open", mergeable: "clean", checks: "pass" });
    await t.auto.pass();
    expect((await t.op()).auto?.enabled).toBe(true);
    expect(t.auto.landingWait("lab")).toContain("expected main");
    expect((await t.events()).some(e => e.kind === "landed")).toBe(false);
    await mutateOperation(t.home, "lab", op => ({ ...op, auto: { ...op.auto!, enabled: false } }));
    await t.auto.pass();
    expect(t.auto.landingWait("lab")).toBeNull();
  });

  test("finishes by disabling itself once every contact landed", async () => {
    const t = await setup([contact("a", { kind: "audit", lane: lane("/wt/a", "t1", "b/a") })], { delivery: "none" });
    t.setStatus("a", status({ worktree: "/wt/a", complete: true, phase: "complete", ctl: null }));
    await t.auto.pass(); // done (marks landed), then next pass sees all landed
    await t.auto.pass();
    const op = await t.op();
    expect(op.auto?.enabled).toBe(false);
    const autos = (await t.events()).filter((e) => e.kind === "auto");
    expect(autos.at(-1)).toMatchObject({ enabled: false, reason: "every contact landed", by: "board" });
  });

  test("never acts on decision contacts or plan approval", async () => {
    const t = await setup([contact("d", { kind: "decision" }), contact("b")]);
    // b is live, sitting at plan approval; d is a queued decision. Nothing may move.
    t.setStatus("b", status({ worktree: "/wt/b", hold: "plan-approval", ctl: { socket: "/s.sock", generation: 1 } }));
    await seedOperationLaunchedLane(t.home, "b", "/wt/b");
    await t.auto.pass();
    const events = await t.events();
    expect(events.filter((e) => e.kind === "operator")).toEqual([]);
    expect(events.some((e) => e.kind === "landed")).toBe(false);
    expect(events.some((e) => e.kind === "launched" && "contact" in e && e.contact === "d")).toBe(false);
  });
  test("auto off does nothing", async () => {
    const t = await setup([contact("b")], { auto: { enabled: false, launch: true, land: true, maxLive: 4, plans: false, decide: false } });
    await t.auto.pass();
    expect(t.fake.count("frontend.createWorkspace")).toBe(0);
  });

  test("auto.plans sends plan-approve when advertised and conditions met", async () => {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
      auto: { enabled: true, launch: true, land: true, maxLive: 4, plans: true, decide: false },
    });
    t.setStatus("a", status({ hold: "plan-approval", ctl: { socket: "/s", generation: 1 }, actions: ["plan-approve"], plan: { path: "p.md", revision: "r1" } }));
    await t.auto.pass();
    const controlCalls = t.fake.calls.filter((c) => c.port === "fleet" && c.method === "control");
    expect(controlCalls.length).toBeGreaterThan(0);
    expect(controlCalls[controlCalls.length - 1].args).toMatchObject({ op: "plan-approve", args: { revision: "r1" } });
    const events = await readEvents(t.home, "lab");
    expect(events.filter((e) => e.kind === "operator" && e.op === "plan-approve")).toHaveLength(1);
  });

  test("auto.plans does not resend for the same revision", async () => {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
      auto: { enabled: true, launch: true, land: true, maxLive: 4, plans: true, decide: false },
    });
    t.setStatus("a", status({ hold: "plan-approval", ctl: { socket: "/s", generation: 1 }, actions: ["plan-approve"], plan: { path: "p.md", revision: "r1" } }));
    await t.auto.pass();
    await t.auto.pass();
    const events = await readEvents(t.home, "lab");
    expect(events.filter((e) => e.kind === "operator" && e.op === "plan-approve")).toHaveLength(1);
  });

  test("auto.plans does not send when auto.plans off", async () => {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
      auto: { enabled: true, launch: true, land: true, maxLive: 4, plans: false, decide: false },
    });
    t.setStatus("a", status({ hold: "plan-approval", ctl: { socket: "/s", generation: 1 }, actions: ["plan-approve"], plan: { path: "p.md", revision: "r1" } }));
    await t.auto.pass();
    const events = await readEvents(t.home, "lab");
    expect(events.filter((e) => e.kind === "operator" && e.op === "plan-approve")).toHaveLength(0);
  });
  test("auto.plans does not send when not advertised", async () => {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
      auto: { enabled: true, launch: true, land: true, maxLive: 4, plans: true, decide: false },
    });
    t.setStatus("a", status({ hold: "plan-approval", ctl: { socket: "/s", generation: 1 }, actions: ["approve", "continue"], plan: { path: "p.md", revision: "r1" } }));
    await t.auto.pass();
    const events = await readEvents(t.home, "lab");
    expect(events.filter((e) => e.kind === "operator" && e.op === "plan-approve")).toHaveLength(0);
  });
});

/** Give a queued contact a lane mid-test (as if it had launched). */
async function seedOperationLaunchedLane(home: string, ticket: string, worktree: string) {
  await mutateOperation(home, "lab", (op) => ({
    ...op,
    contacts: op.contacts.map((c) =>
      c.ticket === ticket
        ? { ...c, lane: { worktree, branch: `b/${ticket}`, frontend: "orca" as const, terminal: { handle: `t-${ticket}`, incarnationId: `i-${ticket}` } } }
        : c,
    ),
  }));
}
