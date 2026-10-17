import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ActionRequest } from "../../src/board.ts";
import type { AutoMode, Contact } from "../../src/core/types.ts";
import { foldEvents } from "../../src/core/fold.ts";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { createAuto } from "../../src/runtime/auto.ts";
import { createWatcher } from "../../src/runtime/watcher.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { readEvents } from "../../src/store/events.ts";
import { decisionPath, readDecisionPane, writeDecisionPane } from "../../src/store/decisions.ts";
import { readOperation } from "../../src/store/operations.ts";
import { loadProjection } from "../../src/snapshot.ts";
import { contact, fakePorts, removeAll, seedOperation, tempDir, terminal } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

const DECISION: Partial<Contact> = { kind: "decision", options: ["Stay", "Move"], recommended: "Stay" };

async function setup(contacts: Contact[], over: { load?: { live: number; open: number }; auto?: AutoMode } = {}) {
  const home = tempDir("decide", dirs);
  await seedOperation(home, { contacts, ...(over.auto ? { auto: over.auto } : {}) });
  const fake = fakePorts();
  const act = createActionRunner({
    home,
    now: () => new Date("2026-01-01T03:00:00Z"),
    settings: async () => DEFAULT_SETTINGS,
    portsFor: () => fake.ports,
    extras: () => ({ load: over.load ?? { live: 0, open: 0 } }),
    sleep: async () => {},
    token: () => "abc123",
    socketWaitMs: 0,
    run: async () => ({ stdout: "", stderr: "", code: 0 }),
  });
  const warnings: string[] = [];
  const watcher = createWatcher({
    home,
    now: () => new Date("2026-01-01T03:00:00Z"),
    settings: async () => ({ ...DEFAULT_SETTINGS, sampleMs: 60_000 }),
    portsFor: () => fake.ports,
    warn: (m) => warnings.push(m),
  });
  const auto = createAuto({
    home,
    now: () => new Date("2026-01-01T03:00:00Z"),
    settings: async () => DEFAULT_SETTINGS,
    extras: () => ({
      statuses: {},
      owners: {},
      probes: {},
      load: over.load ?? { live: 0, open: 0 },
      vanished: new Set(),
      gone: new Set<string>(),
      decisionPanes: watcher.extras("lab").decisionPanes,
      integrationDirty: null,
    }),
    run: act,
    integrationReady: async () => {},
    warn: (m) => warnings.push(m),
  });
  const events = async () => readEvents(home, "lab");
  const reject = (p: Promise<unknown>) => p.then(
    () => { throw new Error("expected the action to fail"); },
    (e) => e,
  );
  const answer = async (ticket: string, text: string) => {
    const file = decisionPath(home, "lab", ticket);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  return { home, fake, act, watcher, auto, events, reject, answer, warnings };
}

describe("done with a choice", () => {
  test("records decided then landed for a decision contact", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    await t.act({ op: "lab", contact: "D-1", action: "done", args: { choice: "Move", rationale: "legacy" } });
    expect((await t.events()).slice(-3, -1)).toEqual([
      expect.objectContaining({ kind: "decided", contact: "D-1", choice: "Move", rationale: "legacy", by: "operator" }),
      expect.objectContaining({ kind: "landed", contact: "D-1" }),
    ]);
  });

  test("rejects a choice outside the options", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    const e = await t.reject(t.act({ op: "lab", contact: "D-1", action: "done", args: { choice: "Bail" } }));
    expect(e).toMatchObject({ status: 400 });
    expect((await t.events()).some((x) => x.kind === "decided")).toBe(false);
  });

  test("rejects a missing choice when options exist", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    const e = await t.reject(t.act({ op: "lab", contact: "D-1", action: "done", args: {} }));
    expect(e).toMatchObject({ status: 400 });
  });

  test("defaults the choice for a free-text decision", async () => {
    const t = await setup([contact("D-1", { kind: "decision" })]);
    await t.act({ op: "lab", contact: "D-1", action: "done", args: {} });
    expect((await t.events()).at(-3)).toMatchObject({ kind: "decided", choice: "decided" });
  });
});

describe("redecide", () => {
  test("a new decided overturns the old one and stays landed", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    await t.act({ op: "lab", contact: "D-1", action: "done", args: { choice: "Stay" } });
    await t.act({ op: "lab", contact: "D-1", action: "redecide", args: { choice: "Move", rationale: "changed my mind" } });
    const events = await t.events();
    const folded = foldEvents(events);
    expect(folded.contacts["D-1"]?.decision).toMatchObject({ choice: "Move", by: "operator" });
    expect(folded.contacts["D-1"]?.landed).toBe(true);
    expect(events.filter((e) => e.kind === "landed")).toHaveLength(1);
  });

  test("is refused before the decision lands", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    const e = await t.reject(t.act({ op: "lab", contact: "D-1", action: "redecide", args: { choice: "Move" } }));
    expect(e).toMatchObject({ status: 409, code: "refused" });
  });
});

describe("decide-agent", () => {
  test("opens a pane in the integration checkout and records it", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    await t.act({ op: "lab", contact: "D-1", action: "decide-agent", args: {} });
    const opened = t.fake.calls.find((c) => c.method === "openTerminal")?.args as { worktree: string; title: string; argv: string[] };
    const op = await readOperation(t.home, "lab");
    expect(opened.worktree).toBe(op.integration);
    expect(opened.title).toBe("decide D-1");
    expect(opened.argv).toContain("--session-dir");
    expect(opened.argv.at(-1)).toContain('"Stay"');
    expect(await readDecisionPane(t.home, "lab", "D-1")).toMatchObject({ terminal: { handle: "fake" } });
    expect((await t.events()).at(-1)).toMatchObject({ kind: "operator", op: "decide-agent", ok: true });
  });

  test("is refused while a pane is already open", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    await writeDecisionPane(t.home, "lab", "D-1", { terminal: terminal("old"), startedAt: "2026-01-01T00:00:00Z" });
    const e = await t.reject(t.act({ op: "lab", contact: "D-1", action: "decide-agent", args: {} }));
    expect(e).toMatchObject({ status: 409 });
    expect(t.fake.count("frontend.openTerminal")).toBe(0);
  });
});

describe("watcher picks up the answer", () => {
  test("a valid answer decides and lands the contact, then closes the pane", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    await t.act({ op: "lab", contact: "D-1", action: "decide-agent", args: {} });
    t.fake.world.terminals = [{ handle: "fake", incarnationId: "fake-inc", worktree: "/tmp/lab", connected: true }];
    await t.answer("D-1", JSON.stringify({ choice: "Stay", rationale: "safer" }));
    await t.watcher.pass();
    expect((await t.events()).slice(-2)).toEqual([
      expect.objectContaining({ kind: "decided", choice: "Stay", rationale: "safer", by: "agent" }),
      expect.objectContaining({ kind: "landed", contact: "D-1" }),
    ]);
    expect(t.fake.count("frontend.close")).toBe(1);
    expect(await readDecisionPane(t.home, "lab", "D-1")).toBeNull();
    // The answer file stays for audit.
    expect(await Bun.file(decisionPath(t.home, "lab", "D-1")).text()).toContain("Stay");
  });

  test("an invalid answer is recorded once and the pane stays open", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    await t.act({ op: "lab", contact: "D-1", action: "decide-agent", args: {} });
    t.fake.world.terminals = [{ handle: "fake", incarnationId: "fake-inc", worktree: "/tmp/lab", connected: true }];
    await t.answer("D-1", JSON.stringify({ choice: "Bail" }));
    await t.watcher.pass();
    await t.watcher.pass();
    const failures = (await t.events()).filter((e) => e.kind === "operator" && e.op === "decide-agent" && !e.ok);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ error: expect.stringContaining("choice") });
    expect(await readDecisionPane(t.home, "lab", "D-1")).not.toBeNull();
    expect(t.fake.count("frontend.close")).toBe(0);
  });

  test("a pane closed before deciding fails once and frees the slot", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    await t.act({ op: "lab", contact: "D-1", action: "decide-agent", args: {} });
    t.fake.world.terminals = [];
    await t.watcher.pass();
    const failures = (await t.events()).filter((e) => e.kind === "operator" && e.op === "decide-agent" && !e.ok);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ error: "pane closed before deciding" });
    expect(await readDecisionPane(t.home, "lab", "D-1")).toBeNull();
    expect(t.watcher.extras("lab").decisionPanes.has("D-1")).toBe(false);
  });

  test("an open pane counts toward the load and takes the decision off the operator's plate", async () => {
    const t = await setup([contact("D-1", DECISION)]);
    await t.act({ op: "lab", contact: "D-1", action: "decide-agent", args: {} });
    await t.watcher.pass();
    expect(t.watcher.extras("lab").load.open).toBe(1);
    expect(t.watcher.extras("lab").decisionPanes.has("D-1")).toBe(true);
    const view = (await loadProjection(t.home, "lab", DEFAULT_SETTINGS, Date.parse("2026-01-01T03:00:00Z"), t.watcher.extras("lab"))).contacts.find((c) => c.ticket === "D-1");
    expect(view).toMatchObject({ decisionPane: true, attention: false, detail: "An agent is deciding in its pane" });
  });
});

describe("auto.decide", () => {
  const AUTO: AutoMode = { enabled: true, launch: true, land: true, maxLive: 4, plans: false, decide: true };

  test("a recommended decision lands without an agent", async () => {
    const t2 = await setup([contact("D-1", DECISION)], { auto: AUTO });
    await t2.auto.pass();
    expect((await t2.events()).slice(-2)).toEqual([

      expect.objectContaining({ kind: "decided", choice: "Stay", by: "recommended" }),
      expect.objectContaining({ kind: "landed", contact: "D-1" }),
    ]);
    expect(t2.fake.count("frontend.openTerminal")).toBe(0);
  });

  test("without a recommendation an agent pane opens instead", async () => {
    const t = await setup([contact("D-1", { kind: "decision", options: ["A", "B"] })], { auto: AUTO });
    await t.auto.pass();
    expect(await readDecisionPane(t.home, "lab", "D-1")).not.toBeNull();
    expect((await t.events()).at(-1)).toMatchObject({ kind: "operator", op: "decide-agent", ok: true, by: "auto" });
  });

  test("the cap stops the agent path but not the recommended one", async () => {
    const full = { live: 4, open: 8 };
    const t = await setup([contact("D-1", { kind: "decision" }), contact("D-2", DECISION)], { auto: AUTO, load: full });
    await t.auto.pass();
    expect(t.fake.count("frontend.openTerminal")).toBe(0);
    expect((await t.events()).some((e) => e.kind === "decided" && "contact" in e && e.contact === "D-2" && e.by === "recommended")).toBe(true);
  });

});
