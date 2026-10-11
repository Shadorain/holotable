import { afterEach, expect, test } from "bun:test";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { ActionError } from "../../src/runtime/errors.ts";
import { createWatcher } from "../../src/runtime/watcher.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { loadProjection } from "../../src/snapshot.ts";
import { appendEvent, readEvents } from "../../src/store/events.ts";
import { contact, fakePorts, noRun, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

async function setup() {
  const home = tempDir("blocked", dirs);
  await seedOperation(home, {
    contacts: [
      contact("notes", { kind: "decision" }),
      contact("api", { blockedBy: ["notes"] }),
      contact("impl", { lane: lane("/wt/impl", "t1") }),
      contact("dep", { blockedBy: ["impl"] }),
    ],
  });
  const at = "2026-01-01T00:00:01.000Z";
  await appendEvent(home, "lab", { v: 1, at, kind: "blocked", contact: "api", by: ["notes"] });
  await appendEvent(home, "lab", { v: 1, at, kind: "blocked", contact: "dep", by: ["impl"] });
  const fake = fakePorts();
  const now = () => new Date("2026-01-01T01:00:00Z");
  const watcher = createWatcher({ home, now, settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, warn: () => {} });
  const act = createActionRunner({ home, now, settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, extras: watcher.extras, sleep: async () => {}, token: () => "abc123", socketWaitMs: 0, run: noRun });
  const unblocked = async () => (await readEvents(home, "lab")).filter((e) => e.kind === "unblocked").map((e) => ("contact" in e ? e.contact : ""));
  const view = async (ticket: string) => (await loadProjection(home, "lab", DEFAULT_SETTINGS, now().getTime(), watcher.extras("lab"))).contacts.find((c) => c.ticket === ticket)!;
  const refused = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(ActionError);
      return error as ActionError;
    }
    throw new Error("expected refusal");
  };
  return { home, fake, watcher, act, unblocked, view, refused };
}

test("a dependent stays queued and unlaunchable until its blocker has a landed event", async () => {
  const t = await setup();
  await t.watcher.pass();
  expect(await t.view("api")).toMatchObject({ group: "queue", state: "blocked", blockedBy: [{ ticket: "notes", landed: false }] });
  expect((await t.refused(t.act({ op: "lab", contact: "api", action: "launch", args: {} }))).message).toBe("blocked by notes");
  expect(await t.unblocked()).toEqual([]);
  expect(t.fake.count("frontend.createWorkspace")).toBe(0);
});

test("a mission that finished is not a landed blocker", async () => {
  const t = await setup();
  t.fake.world.statuses.set("/wt/impl", status({ worktree: "/wt/impl", complete: true, phase: "complete" }));
  t.fake.world.alive.add("/tmp/x.sock");
  await t.watcher.pass();
  await t.watcher.pass();
  expect((await t.view("impl")).state).toBe("complete");
  expect(await t.view("dep")).toMatchObject({ state: "blocked", group: "queue", blockedBy: [{ ticket: "impl", landed: false }] });
  expect(await t.unblocked()).toEqual([]);
});

test("done on a decision contact lands it, unblocks the dependent exactly once, and launch is then accepted", async () => {
  const t = await setup();
  await t.watcher.pass();
  await t.act({ op: "lab", contact: "notes", action: "done", args: {} });
  expect((await readEvents(t.home, "lab")).find((e) => e.kind === "landed")).toMatchObject({ contact: "notes", via: "manual" });
  await t.watcher.pass();
  await t.watcher.pass();
  expect(await t.unblocked()).toEqual(["api"]);
  expect((await t.view("api")).state).toBe("ready");
  t.fake.world.statuses.set("/wt/api", status({ worktree: "/wt/api" }));
  t.fake.world.alive.add("/tmp/x.sock");
  await t.act({ op: "lab", contact: "api", action: "launch", args: {} });
  expect(t.fake.count("frontend.openTerminal")).toBe(1);
});

test("done is refused for a contact that is not at a done step, and for one already landed", async () => {
  const t = await setup();
  expect((await t.refused(t.act({ op: "lab", contact: "api", action: "done", args: {} }))).status).toBe(409);
  await t.act({ op: "lab", contact: "notes", action: "done", args: {} });
  expect((await t.refused(t.act({ op: "lab", contact: "notes", action: "done", args: {} }))).status).toBe(409);
  expect((await readEvents(t.home, "lab")).filter((e) => e.kind === "landed")).toHaveLength(1);
});
