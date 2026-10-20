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
import { appendEvent, readEvents } from "../../src/store/events.ts";
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
  recover?: boolean;
  /** Tickets whose recorded pane is gone. */
  vanished?: string[];
} = {}) {
  const home = tempDir("auto", dirs);
  await seedOperation(home, {
    frontend: "orca",
    fleet: "omp-mission",
    delivery: opts.delivery ?? "local-merge",
    integration: "/tmp/lab",
    auto: opts.auto ?? AUTO,
    recover: opts.recover ?? false,
    contacts,
  });
  const fake = fakePorts();
  for (const [key, error] of Object.entries(opts.fail ?? {})) fake.world.fail.set(key, error);
  // The launcher's socket poll needs a live status at the worktree openTerminal just made.
  const statuses = new Map(Object.entries(opts.statuses ?? {}));
  const probes = new Map(Object.entries(opts.probes ?? {}));
  const run: Run = async () => ({ stdout: "", stderr: "", code: 0 });
  let autoNow = Date.parse("2026-01-01T03:00:00Z");
  const act = createActionRunner({
    home,
    now: () => new Date(autoNow),
    settings: async () => ({ ...DEFAULT_SETTINGS, cleanup: true }),
    portsFor: () => fake.ports,
    extras: () => ({
      statuses: Object.fromEntries(statuses),
      owners: Object.fromEntries([...statuses.keys()].map(key => [key, "live"])),
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
  const auto = createAuto({
    home,
    now: () => new Date(autoNow),
    settings: async () => ({ ...DEFAULT_SETTINGS, cleanup: true }),
    extras: (opId) => ({
      statuses: Object.fromEntries(statuses),
      owners: Object.fromEntries([...[...statuses.keys()].map(k => [k, "live"]), ...(opts.vanished ?? []).map(k => [k, "offline"])]),
      probes: Object.fromEntries(probes),
      load: opts.load ?? { live: 0, open: 0 },
      vanished: new Set(opts.vanished ?? []),
      gone: new Set<string>(),
      decisionPanes: new Set(),
      integrationDirty: null,
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
  test("launches the ready contact that unblocks the most unlanded work", async () => {
    const t = await setup([contact("a"), contact("b"), contact("c", { blockedBy: ["b"] })]);
    t.liveWorktree("a");
    t.liveWorktree("b");

    await t.auto.pass();

    const launched = (await t.events()).filter((e) => e.kind === "launched").map((e) => ("contact" in e ? e.contact : ""));
    expect(launched).toEqual(["b"]);
    await t.auto.pass();
    const after = (await t.events()).filter((e) => e.kind === "launched").map((e) => ("contact" in e ? e.contact : ""));
    expect(after).toEqual(["b", "a"]);
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

  test("a failed launch backs that contact off without switching auto off; other contacts still launch", async () => {
    const t = await setup([contact("b"), contact("c")], { fail: { "frontend.createWorkspace": new PortError("orca-down", "orca exploded") } });
    t.liveWorktree("b");
    t.liveWorktree("c");
    await t.auto.pass();
    expect((await t.op()).auto?.enabled).toBe(true);
    expect((await t.events()).some((e) => e.kind === "auto" && !e.enabled)).toBe(false);
    expect((await t.events()).flatMap((e) => (e.kind === "operator" && e.op === "launch" && !e.ok ? [e.contact] : []))).toEqual(["b"]);
    t.fake.world.fail.delete("frontend.createWorkspace");
    await t.auto.pass();
    const launched = async () => (await t.events()).filter((e) => e.kind === "launched").map((e) => ("contact" in e ? e.contact : ""));
    expect(await launched()).toEqual(["c"]);
    t.advance(5 * 60_000);
    await t.auto.pass();
    expect(await launched()).toEqual(["c", "b"]);
  });

  test("repeated failures back off 5, 15 and 60 minutes, then stop retrying that contact", async () => {
    const t = await setup([contact("b")], { fail: { "frontend.createWorkspace": new PortError("orca-down", "orca exploded") } });
    const attempts = () => t.fake.count("frontend.createWorkspace");
    await t.auto.pass();
    expect(attempts()).toBe(1);
    for (const wait of [5, 15, 60]) {
      t.advance(wait * 60_000 - 1);
      await t.auto.pass();
      const before = attempts();
      t.advance(1);
      await t.auto.pass();
      expect(attempts()).toBe(before + 1);
    }
    t.advance(24 * 3600_000);
    await t.auto.pass();
    expect(attempts()).toBe(4);
    expect((await t.op()).auto?.enabled).toBe(true);
  });

  describe("failing PR checks", () => {
    const failing: DeliveryProbe = { url: "u", state: "open", mergeable: "clean", checks: "fail", failing: ["lint"] };
    async function checking(opts: { ignoreChecks?: boolean } = {}) {
      const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], { auto: { ...AUTO, launch: false } });
      if (opts.ignoreChecks) await mutateOperation(t.home, "lab", (op) => ({ ...op, ignoreChecks: true }));
      const complete = status({ worktree: "/wt/a", complete: true, phase: "complete", ctl: { socket: "/sim/a.sock", generation: 1 }, actions: ["check"] });
      t.setStatus("a", complete);
      t.setProbe("a", failing);
      const checks = async () => (await t.events()).filter((e) => e.kind === "operator" && e.op === "check" && e.by === "auto");
      return { ...t, complete, checks };
    }

    test("auto sends Check PR once, never lands past red CI, and waits for the mission's result", async () => {
      const t = await checking();
      await t.auto.pass();
      await t.auto.pass();
      expect(await t.checks()).toHaveLength(1);
      expect(t.fake.calls.filter((c) => c.port === "fleet" && c.method === "control").map((c) => c.args)).toEqual([expect.objectContaining({ op: "check" })]);
      expect((await t.events()).some((e) => e.kind === "operator" && e.op.startsWith("land"))).toBe(false);
      t.advance(11 * 60_000);
      await t.auto.pass();
      expect(await t.checks()).toHaveLength(1);
      t.setStatus("a", { ...t.complete, check: { at: new Date(Date.parse("2026-01-01T03:05:00Z")).toISOString(), state: "fixing", detail: "Fixed lint", conflicts: [], threads: { open: 0, total: 0 } } });
      await t.auto.pass();
      expect(await t.checks()).toHaveLength(2);
      t.advance(60 * 60_000);
      t.setStatus("a", { ...t.complete, check: { at: new Date(Date.parse("2026-01-01T03:20:00Z")).toISOString(), state: "fixing", detail: "Fixed again", conflicts: [], threads: { open: 0, total: 0 } } });
      await t.auto.pass();
      expect(await t.checks()).toHaveLength(2);
      expect((await t.op()).auto?.enabled).toBe(true);
    });

    test("a mission that reports it cannot fix the checks is left for the operator", async () => {
      const t = await checking();
      await t.auto.pass();
      t.advance(11 * 60_000);
      t.setStatus("a", { ...t.complete, check: { at: new Date(Date.parse("2026-01-01T03:05:00Z")).toISOString(), state: "checks", detail: "Fails on the base too", conflicts: [], threads: { open: 0, total: 0 } } });
      await t.auto.pass();
      expect(await t.checks()).toHaveLength(1);
    });

    test("pending checks and ignoreChecks never trigger an automatic check", async () => {
      const pending = await checking();
      pending.setProbe("a", { ...failing, checks: "pending", failing: [] });
      await pending.auto.pass();
      expect(await pending.checks()).toHaveLength(0);
      const ignored = await checking({ ignoreChecks: true });
      await ignored.auto.pass();
      expect(await ignored.checks()).toHaveLength(0);
      expect((await ignored.events()).some((e) => e.kind === "landed")).toBe(true);
    });
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

for (const kind of ["quota", "rate-limit"] as const) test(`auto waits for ${kind} before starting more AI work, then resumes`, async () => {
  const t = await setup([contact("a", { lane: lane("/wt/a", "t1") }), contact("b")]);
  t.setStatus("a", status({ worktree: "/wt/a", phase: "review", problem: {
    kind, source: "review", detail: "Provider capacity unavailable", retryAt: kind === "quota" ? null : "2026-01-01T04:00:00Z",
    attempt: 1, completed: 1, total: 2,
  } }));
  t.liveWorktree("b");
  await t.auto.pass();
  expect((await t.op()).contacts.find(c => c.ticket === "b")!.lane).toBeNull();
  expect((await t.op()).auto?.enabled).toBe(true);
  t.setStatus("a", status({ worktree: "/wt/a", phase: "review", next: "Independent review running", problem: null }));
  await t.auto.pass();
  expect((await t.op()).contacts.find(c => c.ticket === "b")!.lane?.worktree).toBe("/wt/b");
});

test("extra repair authorization is opt-in and recorded durably", async () => {
  const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
    auto: { ...AUTO, launch: false, land: false, repairs: true },
  });
  t.setStatus("a", status({
    worktree: "/wt/a", phase: "review", verify: "passed", hold: "blocked", mode: "auto", actions: ["review"],
    problem: { kind: "error", source: "repair-budget", detail: "Confirmed repairs exhausted their budget", retryAt: null, attempt: null, completed: null, total: null },
  }));
  await t.auto.pass();
  await t.auto.pass();
  expect((await t.events()).filter(event => event.kind === "operator" && event.op === "review" && event.ok)).toHaveLength(1);
  expect(t.fake.count("fleet.control")).toBe(1);
  await expect(t.act({ op: "lab", contact: "a", action: "review", args: { repairBudgetOnly: true }, by: "auto" })).rejects.toThrow("already used");
  expect(t.fake.count("fleet.control")).toBe(1);
});

test("automatic extra repairs do not override escalation, Pause, verification failure or disabled intent", async () => {
  for (const blocked of ["triage", "pause", "verify", "disabled"]) {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
      auto: { ...AUTO, launch: false, land: false, repairs: blocked !== "disabled" },
    });
    t.setStatus("a", status({
      worktree: "/wt/a", phase: "review", verify: blocked === "verify" ? "failed" : "passed",
      hold: "blocked", mode: blocked === "pause" ? "pause" : "auto", actions: ["review"],
      problem: { kind: "error", source: blocked === "triage" ? "triage" : "repair-budget", detail: "Needs authorization", retryAt: null, attempt: null, completed: null, total: null },
    }));
    await t.auto.pass();
    expect(t.fake.count("fleet.control")).toBe(0);
  }
});

test("queued extra repair authorization rechecks the producer hold and operation intent", async () => {
  for (const changed of ["escalation", "disabled"]) {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
      auto: { ...AUTO, launch: false, land: false, repairs: true },
    });
    const stale = status({
      worktree: "/wt/a", phase: "review", verify: "passed", hold: "blocked", mode: "auto", actions: ["review"],
      problem: { kind: "error", source: "repair-budget", detail: "Confirmed repairs exhausted", retryAt: null, attempt: null, completed: null, total: null },
    });
    t.setStatus("a", stale);
    if (changed === "escalation")
      t.fake.world.statuses.set("/wt/a", { ...stale, problem: { ...stale.problem!, source: "triage" } });
    else
      await mutateOperation(t.home, "lab", op => ({ ...op, auto: { ...op.auto!, repairs: false } }));
    await t.auto.pass();
    expect(t.fake.count("fleet.control")).toBe(0);
  }
});

test("review requests switch an Auto mission to Force once, then leave its mode to the operator", async () => {
  const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
    auto: { ...AUTO, launch: false, land: false, reviews: true },
  });
  // The fake socket does not change the reported mode, as when the operator sets Auto again.
  t.setStatus("a", status({ worktree: "/wt/a", phase: "review", hold: "none", mode: "auto", actions: ["mode", "review"] }));
  await t.auto.pass();
  await t.auto.pass();
  const sent = t.fake.calls.filter(c => c.port === "fleet" && c.method === "control").map(c => c.args);
  expect(sent).toEqual([{ id: "run-1", op: "mode", args: { mode: "force" } }]);
  await expect(t.act({ op: "lab", contact: "a", action: "mode", args: { mode: "force" }, by: "auto" })).rejects.toThrow("already sent");
  await t.act({ op: "lab", contact: "a", action: "mode", args: { mode: "auto" } });
  expect(t.fake.count("fleet.control")).toBe(2);
});

test("review requests leave Pause, plan review, Force, finished and disabled missions alone", async () => {
  for (const kept of ["pause", "plan", "force", "complete", "disabled"]) {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
      auto: { ...AUTO, launch: false, land: false, reviews: kept !== "disabled" },
    });
    t.setStatus("a", status({
      worktree: "/wt/a", phase: kept === "plan" ? "plan" : "review",
      hold: kept === "plan" ? "plan-approval" : "none",
      mode: kept === "pause" || kept === "force" ? kept : "auto",
      actions: kept === "plan" ? ["plan-approve"] : ["mode"],
      complete: kept === "complete",
    }));
    await t.auto.pass();
    expect(t.fake.count("fleet.control")).toBe(0);
  }
});

test("a queued review request rechecks the fresh mode and refuses any other automatic mode change", async () => {
  const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })], {
    auto: { ...AUTO, launch: false, land: false, reviews: true },
  });
  const stale = status({ worktree: "/wt/a", phase: "execute", hold: "none", mode: "auto", actions: ["mode"] });
  t.setStatus("a", stale);
  t.fake.world.statuses.set("/wt/a", { ...stale, mode: "pause" });
  await t.auto.pass();
  await expect(t.act({ op: "lab", contact: "a", action: "mode", args: { mode: "pause" }, by: "auto" })).rejects.toThrow("only request reviews");
  expect(t.fake.count("fleet.control")).toBe(0);
});

test("auto leaves a crashed mission's slot for Recovery instead of launching new work into it", async () => {
  for (const recover of [true, false]) {
    const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") }), contact("b")], {
      auto: { ...AUTO, maxLive: 4 }, load: { live: 3, open: 3 }, recover, vanished: ["a"],
    });
    await appendEvent(t.home, "lab", { v: 1, at: "2026-01-01T02:00:00.000Z", kind: "launched", contact: "a", worktree: "/wt/a", frontend: "orca", terminal: { handle: "t1", incarnationId: "i1" } });
    t.setStatus("a", status({ worktree: "/wt/a", phase: "execute", hold: "none" }));
    t.liveWorktree("b");
    await t.auto.pass();
    const launched = (await t.events()).some(e => e.kind === "launched" && "contact" in e && e.contact === "b");
    expect(launched).toBe(!recover);
  }
});
