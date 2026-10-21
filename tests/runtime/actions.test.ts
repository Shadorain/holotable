import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { ompMissionFleet } from "../../src/adapters/fleet-omp-mission.ts";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { ActionError } from "../../src/runtime/errors.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { readEvents } from "../../src/store/events.ts";
import { holotableToolDefs } from "../../src/plugin/tools.ts";
import { contact, fakePorts, noRun, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  removeAll(dirs);
});

type Reply = Record<string, unknown>;

/** Real fleet adapter + real status file + a stub unix-socket owner; frontend is the fake. */
async function setup(reply: Reply = { v: 1, ok: true, revision: "r1" }, { listening = true } = {}) {
  const home = tempDir("act", dirs);
  const agentDir = tempDir("agent", dirs);
  const worktree = tempDir("wt", dirs);
  await seedOperation(home, { contacts: [contact("a", { lane: lane(worktree, "t1") })] });
  const socket = join(tempDir("sock", dirs), "owner.sock");
  const requests: Array<Record<string, unknown>> = [];
  if (listening) {
    const server = createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        requests.push(JSON.parse(buffer));
        conn.write(`${JSON.stringify(reply)}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socket, resolve));
  }
  const dir = join(agentDir, "missions", "key", "status");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "run-1.json");
  writeFileSync(file, JSON.stringify(status({ worktree, hold: "gate", gate: { kind: "pause", id: "g123456789ab" }, actions: ["approve", "continue"], ctl: { socket, generation: 1 } })));
  const fake = fakePorts();
  const act = createActionRunner({
    home,
    now: () => new Date("2026-01-01T02:00:00Z"),
    settings: async () => DEFAULT_SETTINGS,
    portsFor: () => ({ ...fake.ports, fleet: ompMissionFleet({ agentDir }) }),
    extras: () => ({}),
    sleep: async () => {},
    token: () => "abc123",
    run: noRun,
  });
  const events = async () => (await readEvents(home, "lab")).filter((e) => e.kind === "operator");
  const refused = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(ActionError);
      return error as ActionError;
    }
    throw new Error("expected the action to fail");
  };
  return { home, fake, act, requests, events, file, refused };
}

test("approve reaches the owner's socket with the current gate id and records the click", async () => {
  const t = await setup();
  await t.act({ op: "lab", contact: "a", action: "approve", args: {} });
  expect(t.requests).toEqual([{ v: 1, op: "approve", args: { gate: "g123456789ab" }, operator: true }]);
  expect(await t.events()).toMatchObject([{ contact: "a", op: "approve", ok: true }]);
});

test("continue and mode go through the same path; a bad mode never reaches the socket", async () => {
  const t = await setup();
  await t.act({ op: "lab", contact: "a", action: "continue", args: {} });
  await t.act({ op: "lab", contact: "a", action: "mode", args: { mode: "pause" } });
  expect(t.requests.map((r) => [r.op, r.args])).toEqual([["continue", {}], ["mode", { mode: "pause" }]]);
  const bad = await t.refused(t.act({ op: "lab", contact: "a", action: "mode", args: { mode: "turbo" } }));
  expect(bad).toMatchObject({ status: 400, code: "bad-request" });
  expect(t.requests).toHaveLength(2);
});

test("a gone owner fails as owner-offline, is recorded, and leaves the status untouched", async () => {
  const t = await setup(undefined, { listening: false });
  const before = readFileSync(t.file, "utf8");
  const failure = await t.refused(t.act({ op: "lab", contact: "a", action: "approve", args: {} }));
  expect(failure).toMatchObject({ status: 409, code: "owner-offline" });
  expect(readFileSync(t.file, "utf8")).toBe(before);
  expect(await t.events()).toMatchObject([{ op: "approve", ok: false, error: expect.stringContaining("owner-offline") }]);
});

test("a gate that moved on between render and click surfaces as stale", async () => {
  const t = await setup({ v: 1, ok: false, error: { code: "stale", message: "gate changed" } });
  const failure = await t.refused(t.act({ op: "lab", contact: "a", action: "approve", args: {} }));
  expect(failure).toMatchObject({ status: 409, code: "stale", message: "gate changed" });
});

test("the owner refusing (rejected, busy) is a conflict the operator can read", async () => {
  const t = await setup({ v: 1, ok: false, error: { code: "rejected", message: "Resume hold: run /mission continue first" } });
  const failure = await t.refused(t.act({ op: "lab", contact: "a", action: "continue", args: {} }));
  expect(failure).toMatchObject({ status: 409, code: "rejected" });
  expect(failure.message).toContain("Resume hold");
});

test("focus calls the frontend once with the recorded terminal, never the fleet, and leaves no event", async () => {
  const t = await setup();
  await t.act({ op: "lab", contact: "a", action: "focus", args: {} });
  expect(t.fake.count("frontend.focus")).toBe(1);
  expect(t.fake.calls[0]?.args).toMatchObject({ t: { handle: "t1", incarnationId: "t1-inc" } });
  expect(t.requests).toEqual([]);
  expect(await t.events()).toEqual([]);
});

test("focus forwards the purpose to the frontend", async () => {
  const t = await setup();
  await t.act({ op: "lab", contact: "a", action: "focus", args: { purpose: "plan-approval" } });
  expect(t.fake.calls.at(-1)?.args).toMatchObject({ purpose: "plan-approval" });
});

test("answer goes to the owner's socket only while that same question is open and answerable", async () => {
  const t = await setup();
  const ask = { id: "call-7", questions: [{ question: "How far?", options: ["Status only", "Status + send"], recommended: 0, multi: false }] };
  const open = JSON.parse(readFileSync(t.file, "utf8"));
  writeFileSync(t.file, JSON.stringify({ ...open, hold: "question", gate: null, actions: ["answer"], ask }));
  await t.act({ op: "lab", contact: "a", action: "answer", args: { id: "call-7", answers: [{ option: 1 }] } });
  expect(t.requests).toEqual([{ v: 1, op: "answer", args: { id: "call-7", answers: [{ option: 1 }] }, operator: true }]);
  // The pane moved on to another question, or the answer does not fit: nothing is sent.
  expect(await t.refused(t.act({ op: "lab", contact: "a", action: "answer", args: { id: "call-6", answers: [{ option: 0 }] } }))).toMatchObject({ status: 409, code: "stale" });
  expect(await t.refused(t.act({ op: "lab", contact: "a", action: "answer", args: { id: "call-7", answers: [{ option: 5 }] } }))).toMatchObject({ status: 400 });
  expect(await t.refused(t.act({ op: "lab", contact: "a", action: "answer", args: { id: "call-7", answers: [{ option: 0 }] }, by: "auto" }))).toMatchObject({ status: 403 });
  // A pane that cannot take board answers (older extension) is never sent one.
  writeFileSync(t.file, JSON.stringify({ ...open, hold: "question", gate: null, actions: [], ask }));
  expect(await t.refused(t.act({ op: "lab", contact: "a", action: "answer", args: { id: "call-7", answers: [{ option: 0 }] } }))).toMatchObject({ code: "stale" });
  expect(t.requests).toHaveLength(1);
});

test("the model tools never touch the fleet or the frontend", async () => {
  const t = await setup();
  const tools = holotableToolDefs({ home: t.home, current: () => "lab", now: () => new Date("2026-01-01T02:00:00Z") });
  await tools.state.execute({});
  await tools.queue.execute({ action: "add", ticket: "b", zone: "ops" });
  await tools.queue.execute({ action: "update", ticket: "b", title: "x" });
  expect(t.fake.calls).toEqual([]);
  expect(t.requests).toEqual([]);
});

test("model recovery refuses automation and withdrawn capability without changing mission state", async () => {
  const t = await setup();
  const req = { op: "lab", contact: "a", action: "retry-model", args: { model: "p/new" } };
  expect(await t.refused(t.act({ ...req, by: "auto" }))).toMatchObject({ status: 403 });
  const before = readFileSync(t.file, "utf8");
  expect(await t.refused(t.act(req))).toMatchObject({ status: 409 });
  expect(readFileSync(t.file, "utf8")).toBe(before);
  expect(t.requests.filter((request) => request.op === "retry-model")).toEqual([]);
  const live = JSON.parse(before);
  live.actions = ["retry-model"];
  writeFileSync(t.file, JSON.stringify(live));
  expect(await t.refused(t.act({ ...req, args: { model: "" } }))).toMatchObject({ status: 400 });
  expect(t.requests.filter((request) => request.op === "retry-model")).toEqual([]);
});
