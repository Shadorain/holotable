import { afterEach, describe, expect, test } from "bun:test";
import type { Contact, ContactStatus } from "../../src/core/types.ts";
import type { Ports } from "../../src/ports.ts";
import { PortError } from "../../src/ports.ts";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { liveCount } from "../../src/core/fold.ts";
import { foldEvents } from "../../src/core/fold.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { readEvents } from "../../src/store/events.ts";
import { readOperation } from "../../src/store/operations.ts";
import { contact, fakePorts, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

interface SetupOpts {
  cleanup: boolean;
  /** What `git status --porcelain` reports inside lane worktrees. */
  worktreeStatus?: string;
  /** Make frontend.close throw PortError("terminal-missing"). */
  terminalMissing?: boolean;
}

async function setup(opts: SetupOpts, contacts: Contact[] = [contact("a", { lane: lane("/wt/a", "t1", "b/a") })]) {
  const home = tempDir("clean", dirs);
  await seedOperation(home, { integration: "/tmp/lab", delivery: "local-merge", contacts });
  const fake = fakePorts();
  const statuses = new Map<string, ContactStatus>();
  for (const c of contacts) {
    if (!c.lane) continue;
    fake.world.statuses.set(c.lane.worktree, status({ worktree: c.lane.worktree, complete: true, phase: "complete", ctl: null }));
    statuses.set(c.ticket, status({ worktree: c.lane.worktree, complete: true, phase: "complete", ctl: null }));
  }
  if (opts.terminalMissing)
    fake.ports.frontend = {
      ...fake.ports.frontend,
      close: async (t, w) => {
        fake.calls.push({ port: "frontend", method: "close", args: { t, w } });
        throw new PortError("terminal-missing", "that terminal is gone");
      },
    };
  // git answers only status --porcelain (per directory) and HEAD rev-parse; anything else fails loudly.
  const run = async (command: string, args: string[], cwd: string) => {
    if (command !== "git") throw new Error(`unexpected spawn: ${command}`);
    if (args[0] === "status" && cwd === "/tmp/lab") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "rev-parse" && args[1] === "HEAD" && cwd === "/tmp/lab") return { stdout: "abc\n", stderr: "", code: 0 };
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && cwd === "/tmp/lab") return { stdout: "main\n", stderr: "", code: 0 };
    if (args[0] === "status") return { stdout: opts.worktreeStatus ?? "", stderr: "", code: 0 };
    throw new Error(`unexpected git ${args.join(" ")} in ${cwd}`);
  };
  const act = createActionRunner({
    home,
    now: () => new Date("2026-01-01T03:00:00Z"),
    settings: async () => ({ ...DEFAULT_SETTINGS, cleanup: opts.cleanup }),
    portsFor: () => fake.ports,
    extras: () => ({ statuses: Object.fromEntries(statuses), owners: {}, probes: {}, load: { live: 0, open: 0 } }),
    sleep: async () => {},
    token: () => "abc123",
    socketWaitMs: 0,
    run,
  });
  const events = async () => readEvents(home, "lab");
  const kinds = async () => (await events()).map((e) => e.kind);
  const op = () => readOperation(home, "lab");
  return { home, fake, act, events, kinds, op };
}

describe("cleanup after land", () => {
  test("a clean land with cleanup on closes the terminal, removes the worktree and frees the cap", async () => {
    const t = await setup({ cleanup: true });
    await t.act({ op: "lab", contact: "a", action: "land", args: {} });
    expect(t.fake.count("frontend.close")).toBe(1);
    expect(t.fake.count("frontend.removeWorkspace")).toBe(1);
    const op = await t.op();
    // lane stays on the record; the reaped event is what frees the cap
    const derived = foldEvents(await t.events());
    expect(derived.contacts.a?.reaped).toBe(true);
    const kinds = await t.kinds();
    expect(kinds).toContain("landed");
    expect(kinds).toContain("reaped");
    expect(kinds).toContain("removed");
    expect(liveCount(op, derived)).toBe(0);
  });

  test("regression: a landed contact counts toward live until cleanup reaps it", async () => {
    // Before the fix the land left terminal + lane behind, so liveCount stayed 1 and the cap stayed full.
    const t = await setup({ cleanup: true });
    await t.act({ op: "lab", contact: "a", action: "land", args: {} });
    const op = await t.op();
    const derived = foldEvents(await t.events());
    expect(liveCount(op, derived)).toBe(0);
  });

  test("a dirty lane worktree is left alone and reports an operator cleanup failure", async () => {
    const t = await setup({ cleanup: true, worktreeStatus: " M src/dirty.ts\n" });
    await t.act({ op: "lab", contact: "a", action: "land", args: {} });
    expect(t.fake.count("frontend.removeWorkspace")).toBe(0);
    const op = await t.op();
    expect(op.contacts[0]?.lane?.worktree).toBe("/wt/a");
    const events = await t.events();
    expect(events.find((e) => e.kind === "removed")).toBeUndefined();
    expect(events.find((e) => e.kind === "operator" && e.op === "cleanup")).toMatchObject({ ok: false });
  });

  test("a terminal that is already gone is tolerated and still marked reaped", async () => {
    const t = await setup({ cleanup: true, terminalMissing: true });
    await t.act({ op: "lab", contact: "a", action: "land", args: {} });
    expect(t.fake.count("frontend.close")).toBe(1);
    expect((await t.kinds())).toContain("reaped");
    expect((await t.kinds())).toContain("removed");
  });

  test("cleanup off keeps the terminal and worktree for Reap", async () => {
    const t = await setup({ cleanup: false });
    await t.act({ op: "lab", contact: "a", action: "land", args: {} });
    expect(t.fake.count("frontend.close")).toBe(0);
    expect(t.fake.count("frontend.removeWorkspace")).toBe(0);
    const op = await t.op();
    expect(op.contacts[0]?.lane?.terminal).not.toBeNull();
    expect((await t.kinds())).not.toContain("removed");
  });

  test("landing the contact also cleans up its completed conflict mission", async () => {
    const t = await setup({ cleanup: true }, [
      contact("a", { lane: lane("/wt/a", "t1", "b/a") }),
      contact("a-conflict-1", { kind: "conflict", conflictOf: "a", lane: lane("/wt/a-conflict-1", "t2", "b/a-conflict-1") }),
    ]);
    // a-conflict-1 is complete; mark it landed-in-effect via a real land event would need its own land —
    // the cleanup sweep must handle any conflict contact of "a" whose lane is still recorded.
    await t.act({ op: "lab", contact: "a", action: "land", args: {} });
    const derived = foldEvents(await t.events());
    // both the contact and its conflict mission are reaped and removed
    expect(derived.contacts.a?.reaped).toBe(true);
    expect(derived.contacts["a-conflict-1"]?.reaped).toBe(true);
    expect((await t.events()).filter((e) => e.kind === "removed")).toHaveLength(2);
    expect(t.fake.count("frontend.close")).toBe(2);
    expect(t.fake.count("frontend.removeWorkspace")).toBe(2);
  });
});

describe("done cleanup", () => {
  test("done on a complete contact with a lane runs the same cleanup", async () => {
    const home = tempDir("clean", dirs);
    await seedOperation(home, {
      delivery: "none",
      contacts: [contact("a", { kind: "audit", lane: lane("/wt/a", "t1", "b/a") })],
    });
    const fake = fakePorts();
    fake.world.statuses.set("/wt/a", status({ worktree: "/wt/a", complete: true, phase: "complete", ctl: null }));
    const run = async (_c: string, args: string[]) =>
      ({ stdout: args[0] === "status" ? "" : "", stderr: "", code: 0 });
    const act = createActionRunner({
      home,
      now: () => new Date("2026-01-01T03:00:00Z"),
      settings: async () => ({ ...DEFAULT_SETTINGS, cleanup: true }),
      portsFor: () => fake.ports,
      extras: () => ({ statuses: { a: status({ worktree: "/wt/a", complete: true, phase: "complete", ctl: null }) }, owners: {}, probes: {}, load: { live: 0, open: 0 } }),
      sleep: async () => {},
      token: () => "abc123",
      socketWaitMs: 0,
      run,
    });
    await act({ op: "lab", contact: "a", action: "done", args: {} });
    const kinds = (await readEvents(home, "lab")).map((e) => e.kind);
    expect(kinds).toContain("landed");
    expect(kinds).toContain("reaped");
    expect(kinds).toContain("removed");
  });
});
