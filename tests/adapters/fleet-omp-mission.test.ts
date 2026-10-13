import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Contact, ContactStatus, Operation } from "../../src/core/types.ts";
import { ompMissionFleet } from "../../src/adapters/fleet-omp-mission.ts";
import { PortError } from "../../src/ports.ts";
import { contact, operation } from "../helpers.ts";

const dirs: string[] = [];
const servers: Server[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "holotable-fleet-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeStatus(worktree: string, extra: Record<string, unknown> = {}): ContactStatus {
  return {
    schema: 1,
    id: "run-1",
    ticket: "alpha",
    title: "Alpha",
    worktree,
    base: "main",
    phase: "work",
    progress: null,
    hold: "none",
    gate: null,
    next: null,
    actions: [],
    workers: null,
    delivery: null,
    complete: false,
    revision: "r1",
    ctl: null,
    plan: null,
    mode: null,
    usage: null,
    verify: null,
    updatedAt: "2026-10-09T00:00:00.000Z",
    ...extra,
  } as ContactStatus;
}

async function writeStatus(agentDir: string, workspace: string, name: string, status: object | string): Promise<string> {
  const dir = join(agentDir, "missions", workspace, "status");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, typeof status === "string" ? status : `${JSON.stringify(status)}\n`);
  return path;
}

async function stubSocket(
  dir: string,
  respond: (request: Record<string, unknown>) => object | null,
): Promise<{ path: string; seen: Record<string, unknown>[] }> {
  const path = join(dir, "ctl.sock");
  const seen: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      seen.push(request);
      const reply = respond(request);
      socket.end(reply === null ? "" : `${JSON.stringify(reply)}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(path, resolveListen));
  return { path, seen };
}

describe("fleet.read", () => {
  test("joins by worktree realpath and picks the newest updatedAt", async () => {
    const home = tempDir();
    const agentDir = join(home, "agent");
    const real = join(home, "real-worktree");
    const link = join(home, "linked-worktree");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const fleet = ompMissionFleet({ agentDir });
    await writeStatus(agentDir, "ws1", "old.json", makeStatus(real, { updatedAt: "2026-10-09T00:00:00.000Z" }));
    await writeStatus(agentDir, "ws1", "new.json", makeStatus(real, { id: "run-2", updatedAt: "2026-10-09T01:00:00.000Z" }));
    await writeStatus(agentDir, "ws2", "other.json", makeStatus(join(home, "elsewhere")));
    const found = await fleet.read({ worktree: link });
    expect(found?.id).toBe("run-2");
    expect(await fleet.read({ worktree: join(home, "missing") })).toBeNull();
  });

  test("skips invalid status files and reports them", async () => {
    const home = tempDir();
    const agentDir = join(home, "agent");
    const real = join(home, "worktree");
    mkdirSync(real, { recursive: true });
    const skipped: string[] = [];
    const fleet = ompMissionFleet({ agentDir, onInvalidStatus: (path) => skipped.push(path) });
    await writeStatus(agentDir, "ws", "bad.json", makeStatus(real, { schema: 2 }));
    await writeStatus(agentDir, "ws", "good.json", makeStatus(real));
    expect((await fleet.read({ worktree: real }))?.id).toBe("run-1");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("bad.json");
  });

  test("missing missions directory reads as null", async () => {
    const fleet = ompMissionFleet({ agentDir: join(tempDir(), "agent") });
    expect(await fleet.read({ worktree: tempDir() })).toBeNull();
  });
});

describe("fleet.ping", () => {
  test("false when ctl is null or the socket is dead", async () => {
    const home = tempDir();
    const fleet = ompMissionFleet({ agentDir: join(home, "agent") });
    expect(await fleet.ping(makeStatus(home))).toBe(false);
    expect(await fleet.ping(makeStatus(home, { ctl: { socket: join(home, "gone.sock"), generation: 1 } }))).toBe(false);
  });

  test("true when the socket answers ok", async () => {
    const home = tempDir();
    const { path, seen } = await stubSocket(home, () => ({ v: 1, ok: true, revision: "r1" }));
    const fleet = ompMissionFleet({ agentDir: join(home, "agent") });
    const status = makeStatus(home, { ctl: { socket: path, generation: 1 } });
    expect(await fleet.ping(status)).toBe(true);
    expect(seen[0]).toEqual({ v: 1, op: "ping" });
  });
});

describe("fleet.control", () => {
  test("sends operator payload and resolves on ok", async () => {
    const home = tempDir();
    const { path, seen } = await stubSocket(home, () => ({ v: 1, ok: true, revision: "r2" }));
    const fleet = ompMissionFleet({ agentDir: join(home, "agent") });
    const status = makeStatus(home, { ctl: { socket: path, generation: 1 } });
    await fleet.control(status, "continue", { reason: "go" });
    expect(seen[0]).toEqual({ v: 1, op: "continue", args: { reason: "go" }, operator: true });
  });

  test("approve carries the current gate id", async () => {
    const home = tempDir();
    const { path, seen } = await stubSocket(home, () => ({ v: 1, ok: true, revision: "r3" }));
    const fleet = ompMissionFleet({ agentDir: join(home, "agent") });
    const status = makeStatus(home, {
      ctl: { socket: path, generation: 1 },
      gate: { kind: "pause", id: "abc123def456" },
    });
    await fleet.control(status, "approve", {});
    expect((seen[0].args as Record<string, unknown>).gate).toBe("abc123def456");
  });

  test.each(["bad-request", "stale", "busy", "rejected", "no-session"])(
    "maps server error code %s to PortError",
    async (code) => {
      const home = tempDir();
      const { path } = await stubSocket(home, () => ({ v: 1, ok: false, error: { code, message: `nope ${code}` } }));
      const fleet = ompMissionFleet({ agentDir: join(home, "agent") });
      const status = makeStatus(home, { ctl: { socket: path, generation: 1 } });
      try {
        await fleet.control(status, "continue", {});
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe(code);
        expect((error as PortError).message).toBe(`nope ${code}`);
      }
    },
  );

  test("dead socket maps to owner-offline", async () => {
    const home = tempDir();
    const fleet = ompMissionFleet({ agentDir: join(home, "agent") });
    const status = makeStatus(home, { ctl: { socket: join(home, "gone.sock"), generation: 1 } });
    await expect(fleet.control(status, "continue", {})).rejects.toMatchObject({ code: "owner-offline" });
  });

  test("server that closes without replying maps to owner-offline", async () => {
    const home = tempDir();
    const { path } = await stubSocket(home, () => null);
    const fleet = ompMissionFleet({ agentDir: join(home, "agent") });
    const status = makeStatus(home, { ctl: { socket: path, generation: 1 } });
    await expect(fleet.control(status, "continue", {})).rejects.toMatchObject({ code: "owner-offline" });
  });

  test("null ctl throws no-session", async () => {
    const home = tempDir();
    const fleet = ompMissionFleet({ agentDir: join(home, "agent") });
    await expect(fleet.control(makeStatus(home), "continue", {})).rejects.toMatchObject({ code: "no-session" });
  });
});

describe("fleet.launch", () => {
  const fleet = ompMissionFleet({ agentDir: "/unused" });
  const op = (over: Partial<Operation> = {}): Operation => ({ ...operation(), ...over });
  const launch = (operation: Operation, contact: Contact) =>
    fleet.launch({ operation, contact, worktree: "/wt/x", overlay: "/home/launch/plan-default.yml" });

  test("task text and option-looking words cannot become mission flags", () => {
    const task = 'Preserve literal --force and --pause words.\n\nVerify "acceptance" evidence.';
    const local = launch(op({ pause: true }), { ...contact("task-1"), title: "Short", description: task });
    expect(local.env.OMP_MISSION_AUTOSTART).toBe(`/mission --pause -- ${task.replace(/\s+/g, " ")}`);

    const tracked = launch(op({ tracker: "linear", pause: true }), { ...contact("CHR-142"), description: task });
    expect(tracked.env.OMP_MISSION_AUTOSTART).toBe("/mission CHR-142 --pause");
    expect(tracked.argv).toEqual([
      "omp", "--config", "/home/launch/plan-default.yml",
      "--append-system-prompt", `Additional scope for mission CHR-142:\n\n${task}`,
    ]);
  });
});

