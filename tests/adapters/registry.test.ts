import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Contact, ContactStatus, Operation, TerminalRef } from "../../src/core/types.ts";
import { resolvePorts } from "../../src/adapters/registry.ts";
import { PortError, type CommandResult } from "../../src/ports.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "holotable-registry-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function makeOperation(home: string, extra: Partial<Operation> = {}): Operation {
  return {
    v: 1,
    id: "demo",
    name: "Demo",
    repo: join(home, "repo"),
    base: "main",
    integration: join(home, "repo"),
    pause: true,
    tracker: "none",
    fleet: "none",
    frontend: "none",
    delivery: "none",
    zones: [],
    contacts: [],
    project: null,
    recover: false,
    createdAt: "2026-10-09T00:00:00.000Z",
    ...extra,
  };
}

const noopRun = async (): Promise<CommandResult> => ({ stdout: "", stderr: "", code: 0 });

function resolve(op: Operation, home: string) {
  return resolvePorts(op, DEFAULT_SETTINGS, noopRun, join(home, "agent"));
}

const contact: Contact = {
  ticket: "alpha",
  title: null,
  zone: "ops",
  kind: "implement",
  blockedBy: [],
  conflictOf: null,
  lane: null,
};

const status = { ctl: null } as unknown as ContactStatus;
const terminal: TerminalRef = { handle: "h", incarnationId: "i" };

describe("resolvePorts", () => {
  test("an all-none operation resolves the none adapters", () => {
    const home = tempHome();
    const ports = resolve(makeOperation(home), home);
    expect(ports.tracker.id).toBe("none");
    expect(ports.fleet.id).toBe("none");
    expect(ports.frontend.id).toBe("none");
    expect(ports.delivery.id).toBe("none");
  });

  test("registered adapters resolve by operation fields", () => {
    const home = tempHome();
    expect(resolve(makeOperation(home, { tracker: "linear" }), home).tracker.id).toBe("linear");
    expect(resolve(makeOperation(home, { tracker: "github" }), home).tracker.id).toBe("github");
    expect(resolve(makeOperation(home, { fleet: "omp-mission" }), home).fleet.id).toBe("omp-mission");
    expect(resolve(makeOperation(home, { delivery: "github-pr" }), home).delivery.id).toBe("github-pr");
    expect(resolve(makeOperation(home, { delivery: "local-merge" }), home).delivery.id).toBe("local-merge");
  });

  test("every named adapter resolves after slice 6", () => {
    const home = tempHome();
    for (const value of ["orca", "herdr", "custom", "none"] as const)
      expect(resolve(makeOperation(home, { frontend: value }), home).frontend.id).toBe(value);
  });
});

describe("none adapters", () => {
  test("tracker sample returns null", async () => {
    const home = tempHome();
    expect(await resolve(makeOperation(home), home).tracker.sample("alpha", "/tmp")).toBeNull();
  });

  test("fleet read/ping are inert and control/launch throw no-fleet", async () => {
    const home = tempHome();
    const fleet = resolve(makeOperation(home), home).fleet;
    expect(await fleet.read({ worktree: "/tmp" })).toBeNull();
    expect(await fleet.ping(status)).toBe(false);
    expect(() => fleet.launch({ operation: makeOperation(home), contact, worktree: "/tmp", overlay: "" })).toThrow(PortError);
  });

  test("frontend cannot create or drive terminals", async () => {
    const home = tempHome();
    const frontend = resolve(makeOperation(home), home).frontend;
    await expect(
      frontend.createWorkspace({ repo: "/tmp", name: "x", base: "main", ticket: null }),
    ).rejects.toMatchObject({ code: "no-frontend" });
    await expect(
      frontend.openTerminal({ worktree: "/tmp", title: "x", argv: ["true"], env: {} }),
    ).rejects.toMatchObject({ code: "no-frontend" });
    await expect(frontend.listTerminals()).resolves.toBeNull();
    await expect(frontend.focus(terminal, "/tmp")).rejects.toMatchObject({ code: "no-frontend" });
    await expect(frontend.close(terminal, "/tmp")).rejects.toMatchObject({ code: "no-frontend" });
  });

  test("delivery probe returns null and land throws no-delivery", async () => {
    const home = tempHome();
    const delivery = resolve(makeOperation(home), home).delivery;
    await expect(
      delivery.probe({ operation: makeOperation(home), contact, status }),
    ).resolves.toBeNull();
    await expect(
      delivery.land({ operation: makeOperation(home), contact, sourceBranch: "b", status }),
    ).rejects.toMatchObject({ code: "no-delivery" });
  });
});
