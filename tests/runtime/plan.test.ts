import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { ompMissionFleet } from "../../src/adapters/fleet-omp-mission.ts";
import { actionsFor } from "../../src/core/policy.ts";
import { foldEvents } from "../../src/core/fold.ts";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { ActionError } from "../../src/runtime/errors.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { contact, fakePorts, lane, noRun, operation, removeAll, seedOperation, status, tempDir } from "../helpers.ts";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  removeAll(dirs);
});

type Req = Record<string, unknown>;
type Handler = (req: Req) => Record<string, unknown>;

/** Real fleet adapter + a stub control socket speaking the C5 protocol. */
async function setup(handler: Handler) {
  const home = tempDir("plan", dirs);
  const agentDir = tempDir("agent", dirs);
  const worktree = tempDir("wt", dirs);
  await seedOperation(home, { contacts: [contact("a", { lane: lane(worktree, "t1") })] });
  const socket = join(tempDir("sock", dirs), "owner.sock");
  const requests: Req[] = [];
  const server = createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const req = JSON.parse(buffer) as Req;
      requests.push(req);
      conn.write(`${JSON.stringify(handler(req))}\n`);
      conn.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));

  const st = status({
    worktree,
    hold: "plan-approval",
    actions: [],
    plan: { path: `${worktree}/plan.md`, revision: "rev-1" },
    ctl: { socket, generation: 1 },
  });
  const dir = join(agentDir, "missions", "key", "status");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run-1.json"), JSON.stringify(st));
  const fleet = ompMissionFleet({ agentDir });
  const act = createActionRunner({
    home,
    now: () => new Date("2026-01-01T02:00:00Z"),
    settings: async () => DEFAULT_SETTINGS,
    portsFor: () => ({ ...fakePorts().ports, fleet }),
    extras: () => ({ statuses: {}, owners: {}, probes: {}, load: { live: 0, open: 0 }, vanished: new Set<string>(), decisionPanes: new Set<string>() }),
    sleep: async () => {},
    token: () => "abc123",
    run: noRun,
  });
  const refused = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(ActionError);
      return error as ActionError;
    }
    throw new Error("expected the action to fail");
  };
  return { act, fleet, st, requests, refused };
}

describe("plan review", () => {
  test("readPlan returns the owner's plan without an operator flag", async () => {
    const t = await setup((req) =>
      req.op === "plan"
        ? { v: 1, ok: true, plan: { text: "# Do the thing", path: "/wt/plan.md", revision: "rev-1" } }
        : { v: 1, ok: false, error: { code: "rejected", message: "?" } },
    );
    const plan = await t.fleet.readPlan(t.st);
    expect(plan).toEqual({ text: "# Do the thing", path: "/wt/plan.md", revision: "rev-1" });
    expect(t.requests[0]).toMatchObject({ v: 1, op: "plan" });
    expect(t.requests[0]).not.toHaveProperty("operator");
  });

  test("readPlan maps no-plan to null", async () => {
    const t = await setup(() => ({ v: 1, ok: false, error: { code: "no-plan", message: "no pending plan" } }));
    expect(await t.fleet.readPlan(t.st)).toBeNull();
  });

  test("plan-save sends plan-edit with the revision as base", async () => {
    const t = await setup(() => ({ v: 1, ok: true, revision: "rev-2" }));
    await t.act({ op: "lab", contact: "a", action: "plan-save", args: { text: "# Edited", revision: "rev-1" } });
    expect(t.requests[0]).toMatchObject({ v: 1, op: "plan-edit", args: { text: "# Edited", base: "rev-1" }, operator: true });
  });

  test("a stale save surfaces the owner's stale error", async () => {
    const t = await setup(() => ({ v: 1, ok: false, error: { code: "stale", message: "plan moved on; reload" } }));
    const failure = await t.refused(t.act({ op: "lab", contact: "a", action: "plan-save", args: { text: "x", revision: "rev-0" } }));
    expect(failure).toMatchObject({ status: 409, code: "stale", message: "plan moved on; reload" });
  });

  test("plan-refine sends the feedback message", async () => {
    const t = await setup(() => ({ v: 1, ok: true, revision: "rev-2" }));
    await t.act({ op: "lab", contact: "a", action: "plan-refine", args: { message: "handle the empty case" } });
    expect(t.requests[0]).toMatchObject({ v: 1, op: "plan-refine", args: { message: "handle the empty case" }, operator: true });
  });

  test("bad args never reach the socket", async () => {
    const t = await setup(() => ({ v: 1, ok: true, revision: "rev-2" }));
    const failure = await t.refused(t.act({ op: "lab", contact: "a", action: "plan-refine", args: {} }));
    expect(failure).toMatchObject({ status: 400, code: "bad-request" });
    expect(t.requests).toEqual([]);
  });

  test("actionsFor offers plan-save/plan-refine only while a plan awaits approval", () => {
    const op = operation();
    const c = contact("a", { lane: lane("/wt/a", "t1") });
    const base = {
      operation: op,
      contact: c,
      derived: foldEvents([]),
      state: "hold" as const,
      probe: null,
      load: { live: 1, open: 1 },
      cap: 8,
      conflictOpen: null,
      decisionPaneOpen: false,
    };
    const held = status({ hold: "plan-approval", plan: { path: "/p.md", revision: "r1" } });
    const actions = actionsFor({ ...base, status: held, owner: "live" });
    expect(actions.filter((a) => a.id.startsWith("plan-")).map((a) => [a.id, a.enabled])).toEqual([
      ["plan-save", true],
      ["plan-refine", true],
    ]);
    const offline = actionsFor({ ...base, status: held, owner: "offline" });
    expect(offline.find((a) => a.id === "plan-save")).toMatchObject({ enabled: false, reason: "owner-offline" });
    const noPlan = actionsFor({ ...base, status: status({ hold: "plan-approval", plan: null }), owner: "live" });
    expect(noPlan.some((a) => a.id.startsWith("plan-"))).toBe(false);
  });
});
