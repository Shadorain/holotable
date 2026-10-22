import { afterEach, expect, test } from "bun:test";
import type { Contact } from "../../src/core/types.ts";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { createAuto } from "../../src/runtime/auto.ts";
import { ActionError } from "../../src/runtime/errors.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { readEvents } from "../../src/store/events.ts";
import { writeFile } from "node:fs/promises";
import { closerReviewPath, ensureCloserReportDir } from "../../src/store/closer.ts";
import { contact, fakePorts, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";
import { createWatcher } from "../../src/runtime/watcher.ts";
import { makeMeasurements, makeUsageEvidence } from "../core/fixtures.ts";
import { foldEvents } from "../../src/core/fold.ts";
import { evaluateOperation } from "../../src/core/evaluation.ts";
import { readOperation } from "../../src/store/operations.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

async function setup(contacts: Contact[], over: Parameters<typeof seedOperation>[1] = {}) {
  const home = tempDir("guard", dirs);
  await seedOperation(home, { delivery: "github-pr", integration: "/tmp/lab", contacts, ...over });
  const fake = fakePorts();
  const statuses: Record<string, ReturnType<typeof status>> = {};
  for (const c of contacts) {
    if (!c.lane) continue;
    statuses[c.ticket] = status({ ticket: c.ticket, worktree: c.lane.worktree, complete: true, phase: "complete", ctl: null });
    fake.world.statuses.set(c.lane.worktree, statuses[c.ticket]!);
  }
  const extras = () => ({ statuses, owners: {}, probes: Object.fromEntries(fake.world.probes), load: { live: 0, open: 0 }, integrationDirty: null, vanished: new Set<string>(), gone: new Set<string>(), decisionPanes: new Set<string>() });
  const run = async (_command: string, args: string[]) => ({ stdout: args[0] === "rev-parse" ? "main\n" : "", stderr: "", code: 0 });
  const deps = {
    home,
    now: () => new Date("2026-01-01T03:00:00Z"),
    settings: async () => ({ ...DEFAULT_SETTINGS, cleanup: true }),
    portsFor: () => fake.ports,
    extras,
    sleep: async () => {},
    token: () => "abc123",
    socketWaitMs: 0,
    run,
  };
  const watcher=createWatcher({...deps,warn:()=>{}});
  const act=createActionRunner({...deps,captureMetrics:watcher.capture});
  const kinds = async () => (await readEvents(home, "lab")).map((e) => e.kind);
  const failure = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(ActionError);
      return error as ActionError;
    }
    throw new Error("expected the action to fail");
  };
  return { home, fake, act, kinds, failure, deps, extras };
}

const audit = () => contact("a", { kind: "audit", lane: lane("/wt/a", "t1", "b/a") });

test("Mark done refuses an audit whose branch is not in the base, and removes nothing", async () => {
  const t = await setup([audit()]);
  t.fake.world.unmerged.set("a", "PR #242 is still open");
  const failed = await t.failure(t.act({ op: "lab", contact: "a", action: "done", args: {} }));
  expect(failed).toMatchObject({ status: 409, code: "not-merged" });
  expect(failed.message).toContain("PR #242 is still open");
  const kinds = await t.kinds();
  expect(kinds).not.toContain("landed");
  expect(kinds).not.toContain("removed");
  expect(kinds).not.toContain("reaped");
});

test("Mark done on an audit with unmerged commits and no PR opens one for Land instead of refusing forever", async () => {
  const t = await setup([audit()]);
  t.fake.world.unmerged.set("a", "3 commits on b/a not in main");
  const published: string[] = [];
  t.fake.ports.delivery.publish = async (i) => { published.push(i.branch); return { url: "https://github.com/acme/w/pull/9" }; };
  const failed = await t.failure(t.act({ op: "lab", contact: "a", action: "done", args: {} }));
  expect(failed).toMatchObject({ status: 409, code: "pr-opened" });
  expect(failed.message).toContain("pull/9");
  expect(published).toEqual(["b/a"]);
  expect(await t.kinds()).not.toContain("landed");

  // Once the probe sees that PR, Mark done goes back to refusing: Land owns it now.
  t.fake.world.probes.set("a", { url: "https://github.com/acme/w/pull/9", state: "open", mergeable: "clean", checks: "pending" });
  const again = await t.failure(t.act({ op: "lab", contact: "a", action: "done", args: {} }));
  expect(again.code).not.toBe("pr-opened");
  expect(published).toHaveLength(1);
});

test("Mark done lands an audit once its work is really in the base", async () => {
  const t = await setup([audit()]);
  await t.act({ op: "lab", contact: "a", action: "done", args: {} });
  expect(await t.kinds()).toContain("landed");
});

const landedOther = () => contact("x", { kind: "audit", lane: lane("/wt/x", "t0", "b/x") });
const closer = () => contact("CLOSER", { kind: "closer", lane: lane("/wt/closer", "t2", "b/closer") });

test("Mark done lands a closer that changed nothing: its branch is already in the base", async () => {
  const t = await setup([landedOther(), closer()]);
  await t.act({ op: "lab", contact: "x", action: "done", args: {} });
  await t.act({ op: "lab", contact: "CLOSER", action: "done", args: {} });
  expect((await readEvents(t.home, "lab")).filter((e) => e.kind === "landed").map((e) => ("contact" in e ? e.contact : ""))).toEqual(["x", "CLOSER"]);
  expect(t.fake.count("delivery.verifyMerged")).toBe(2);
});

test("Mark done on a closer with fixes and no PR opens one for Land, like an audit", async () => {
  const t = await setup([landedOther(), closer()]);
  await t.act({ op: "lab", contact: "x", action: "done", args: {} });
  t.fake.world.unmerged.set("CLOSER", "1 commit on b/closer not in main");
  const published: string[] = [];
  t.fake.ports.delivery.publish = async (i) => { published.push(i.branch); return { url: "https://github.com/acme/w/pull/12" }; };
  const failed = await t.failure(t.act({ op: "lab", contact: "CLOSER", action: "done", args: {} }));
  expect(failed).toMatchObject({ status: 409, code: "pr-opened" });
  expect(published).toEqual(["b/closer"]);
  expect((await readEvents(t.home, "lab")).some((e) => e.kind === "landed" && e.contact === "CLOSER")).toBe(false);
});

test("a closer's PR is opened with its review's prNotes and summary", async () => {
  const t = await setup([landedOther(), closer()]);
  await t.act({ op: "lab", contact: "x", action: "done", args: {} });
  await ensureCloserReportDir(t.home, "lab");
  await writeFile(closerReviewPath(t.home, "lab", "CLOSER"), JSON.stringify({ v: 1, summary: "Removed a duplicate helper.", fixes: [{ title: "One retry helper" }], prNotes: "Guardrail-change: CI timeout raised" }));
  t.fake.world.unmerged.set("CLOSER", "1 commit on b/closer not in main");
  const bodies: string[] = [];
  t.fake.ports.delivery.publish = async (i) => { bodies.push(i.body); return { url: "https://github.com/acme/w/pull/13" }; };
  await t.failure(t.act({ op: "lab", contact: "CLOSER", action: "done", args: {} }));
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain("Guardrail-change: CI timeout raised");
  expect(bodies[0]).toContain("Removed a duplicate helper.");
  expect(bodies[0]).toContain("One retry helper");
});

test("a decision contact never asks the delivery about a merge", async () => {
  const t = await setup([contact("d", { kind: "decision", options: ["Stay", "Move"] })]);
  await t.act({ op: "lab", contact: "d", action: "done", args: { choice: "Stay" } });
  expect(t.fake.count("delivery.verifyMerged")).toBe(0);
});

test("Land never records landed when the base does not contain the branch afterwards", async () => {
  const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })]);
  t.fake.world.unmerged.set("a", "PR #7 is still open");
  const failed = await t.failure(t.act({ op: "lab", contact: "a", action: "land", args: {} }));
  expect(failed).toMatchObject({ status: 409, code: "not-merged" });
  const kinds = await t.kinds();
  expect(kinds).not.toContain("landed");
  expect(kinds).not.toContain("removed");
});

test("Check needs an operator or opted-in auto landing, and the mission must offer it", async () => {
  const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })]);
  expect(await t.failure(t.act({ op: "lab", contact: "a", action: "check", args: {}, by: "recover" }))).toMatchObject({ status: 403 });
  expect(await t.failure(t.act({ op: "lab", contact: "a", action: "check", args: {}, by: "auto" }))).toMatchObject({ status: 409, code: "refused" });
  expect(await t.failure(t.act({ op: "lab", contact: "a", action: "check", args: {} }))).toMatchObject({ status: 409, code: "refused" });
});

test("auto mode leaves an unmerged audit alone instead of pausing, and retries it later", async () => {
  const t = await setup([audit()], { auto: { enabled: true, launch: false, land: true, maxLive: 2, plans: false, decide: false } });
  t.fake.world.unmerged.set("a", "3 commits on b/a not in main");
  let now = new Date("2026-01-01T03:00:00Z").getTime();
  const requests: string[] = [];
  const auto = createAuto({
    home: t.home,
    now: () => new Date(now),
    settings: async () => DEFAULT_SETTINGS,
    extras: t.extras,
    run: async (req) => {
      requests.push(req.action);
      await t.act(req);
    },
    integrationReady: async () => {},
    warn: () => {},
  });
  await auto.pass();
  await auto.pass();
  expect(requests).toEqual(["done"]);
  const events = await readEvents(t.home, "lab");
  expect(events.filter((e) => e.kind === "auto" && e.enabled === false)).toEqual([]);
  now += 11 * 60_000;
  t.fake.world.unmerged.clear();
  await auto.pass();
  expect(requests).toEqual(["done", "done"]);
  expect((await t.kinds())).toContain("landed");
});

test.each(["land","done","reap"] as const)("%s retains final usage before terminal cleanup with only the required fleet read",async(action)=>{
 const t=await setup([action==="done"?audit():contact("a",{lane:lane("/wt/a","t1","b/a")})]);
 t.fake.world.statuses.set("/wt/a",status({phase:"complete",complete:true,ctl:null,measurements:makeMeasurements({recordedPassed:3}),usageEvidence:makeUsageEvidence(41)}));
 const close=t.fake.ports.frontend.close;
 t.fake.ports.frontend.close=async(...args)=>{t.fake.world.statuses.delete("/wt/a");await close(...args);};
 await t.act({op:"lab",contact:"a",action,args:{}});
 const events=await readEvents(t.home,"lab"),boundary=events.findIndex(e=>e.kind===(action==="reap"?"reaped":"landed")),sample=events.findIndex(e=>e.kind==="sample");
 expect(sample).toBeGreaterThanOrEqual(0);expect(sample).toBeLessThan(boundary);
 const result=evaluateOperation(await readOperation(t.home,"lab"),foldEvents(events),Date.parse("2026-01-01T03:00:00Z"));
 expect(result.usage.tokens?.input).toBe(41);expect(result.quality?.recordedPassed).toBe(3);
 expect(t.fake.count("fleet.read")).toBe(1);
 expect(t.fake.count("tracker.sample")).toBe(0);expect(t.fake.count("fleet.ping")).toBe(0);
});
