import { afterEach, expect, test } from "bun:test";
import type { Contact } from "../../src/core/types.ts";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { createAuto } from "../../src/runtime/auto.ts";
import { ActionError } from "../../src/runtime/errors.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { readEvents } from "../../src/store/events.ts";
import { contact, fakePorts, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";

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
  const extras = () => ({ statuses, owners: {}, probes: Object.fromEntries(fake.world.probes), load: { live: 0, open: 0 }, integrationDirty: null, vanished: new Set<string>(), decisionPanes: new Set<string>() });
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
  const act = createActionRunner(deps);
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

test("Mark done lands an audit once its work is really in the base", async () => {
  const t = await setup([audit()]);
  await t.act({ op: "lab", contact: "a", action: "done", args: {} });
  expect(await t.kinds()).toContain("landed");
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

test("Check is an operator click: automation is refused and the mission must offer it", async () => {
  const t = await setup([contact("a", { lane: lane("/wt/a", "t1", "b/a") })]);
  expect(await t.failure(t.act({ op: "lab", contact: "a", action: "check", args: {}, by: "auto" }))).toMatchObject({ status: 403 });
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
