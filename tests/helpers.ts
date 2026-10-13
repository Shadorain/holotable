import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Contact,
  ContactStatus,
  ControlOp,
  DeliveryProbe,
  Operation,
  TerminalRef,
} from "../src/core/types.ts";
import type { Ports, Run, TrackerHit } from "../src/ports.ts";
import { appendEvent } from "../src/store/events.ts";
import { createOperation } from "../src/store/operations.ts";

export const T0 = "2026-01-01T00:00:00.000Z";

export function tempDir(prefix: string, bucket: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), `holotable-${prefix}-`));
  bucket.push(dir);
  return dir;
}
export function removeAll(bucket: string[]): void {
  for (const dir of bucket.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function contact(ticket: string, over: Partial<Contact> = {}): Contact {
  return { ticket, title: null, description: null, zone: "ops", kind: "implement", blockedBy: [], conflictOf: null, lane: null, ...over };
}
export const terminal = (handle = "t1"): TerminalRef => ({ handle, incarnationId: `${handle}-inc` });
export function lane(worktree: string, handle: string | null = "t1", branch: string | null = null): Contact["lane"] {
  return { worktree, branch, frontend: "orca", terminal: handle ? terminal(handle) : null };
}

export function operation(over: Partial<Operation> = {}): Operation {
  return {
    v: 1,
    id: "lab",
    name: "Lab",
    repo: "/tmp/lab",
    base: "main",
    integration: "/tmp/lab",
    pause: true,
    tracker: "none",
    fleet: "omp-mission",
    frontend: "orca",
    delivery: "none",
    zones: [{ id: "ops", label: "Ops" }],
    contacts: [],
    project: null,
    createdAt: T0,
    recover: false,
    ...over,
  };
}

/** Create the operation and a `queued` (+`launched` when a terminal is recorded) event per contact. */
export async function seedOperation(home: string, over: Partial<Operation> = {}): Promise<Operation> {
  const op = await createOperation(home, operation(over));
  for (const c of op.contacts) {
    await appendEvent(home, op.id, { v: 1, at: T0, kind: "queued", contact: c.ticket });
    if (c.lane?.terminal)
      await appendEvent(home, op.id, { v: 1, at: T0, kind: "launched", contact: c.ticket, worktree: c.lane.worktree, frontend: "orca", terminal: c.lane.terminal });
  }
  return op;
}

export function status(over: Partial<ContactStatus> = {}): ContactStatus {
  return {
    schema: 1,
    id: "run-1",
    ticket: "a",
    title: "A",
    worktree: "/wt/a",
    base: "main",
    phase: "plan",
    progress: { step: 1, of: 9 },
    hold: "none",
    gate: null,
    next: null,
    actions: [],
    workers: null,
    delivery: null,
    complete: false,
    revision: T0,
    ctl: { socket: "/tmp/x.sock", generation: 100 },
    plan: null,
    mode: null,
    usage: null,
    updatedAt: T0,
    verify: null,
    ...over,
  };
}

export interface FakeCall {
  port: "tracker" | "fleet" | "frontend" | "delivery";
  method: string;
  args: unknown;
}
/** In-memory ports. Mutate `world` between passes; `fail` makes a named method throw. */
export function fakePorts() {
  const calls: FakeCall[] = [];
  const world = {
    statuses: new Map<string, ContactStatus | null>(),
    alive: new Set<string>(),
    tracker: new Map<string, { state: string; url: string | null } | null>(),
    /** Tracker search answers; null simulates an unavailable tracker. */
    searchHits: null as TrackerHit[] | null,
    probes: new Map<string, DeliveryProbe | null>(),
    fail: new Map<string, Error>(),
    /** createWorkspace waits on this when set, to hold a launch mid-flight. */
    hold: null as Promise<void> | null,
    /** What the frontend lists; null means it cannot list. */
    terminals: null as Array<TerminalRef & { worktree: string; connected: boolean }> | null,
  };
  const call = <T>(port: FakeCall["port"], method: string, args: unknown, fn: () => T): T => {
    calls.push({ port, method, args });
    const error = world.fail.get(`${port}.${method}`);
    if (error) throw error;
    return fn();
  };
  const ports: Ports = {
    tracker: {
      id: "linear",
      sample: async (ticket, cwd) => call("tracker", "sample", { ticket, cwd }, () => world.tracker.get(ticket) ?? null),
      search: async (query, cwd, limit) => call("tracker", "search", { query, cwd, limit }, () => world.searchHits?.slice(0, limit) ?? null),
    },
    fleet: {
      id: "omp-mission",
      launch: (i) => call("fleet", "launch", i, () => ({ argv: ["omp", "--config", i.overlay], env: { FAKE_LAUNCH: i.contact.ticket } })),
      read: async (i) => call("fleet", "read", i, () => world.statuses.get(i.worktree) ?? null),
      ping: async (s) => call("fleet", "ping", s.id, () => Boolean(s.ctl && world.alive.has(s.ctl.socket))),
      readPlan: async () => call("fleet", "readPlan", null, () => null),
      control: async (s, op: ControlOp, args) => call("fleet", "control", { id: s.id, op, args }, () => undefined),
    },
    frontend: {
      id: "none",
      ensureRepo: async (repo) => call("frontend", "ensureRepo", repo, () => undefined),
      createWorkspace: async (i) => {
        await world.hold;
        return call("frontend", "createWorkspace", i, () => ({ worktree: `/wt/${i.name}`, branch: `b/${i.name}` }));
      },
      openTerminal: async (i) => call("frontend", "openTerminal", i, () => terminal("fake")),
      listTerminals: async () => call("frontend", "listTerminals", null, () => world.terminals),
      focus: async (t, w, purpose) => call("frontend", "focus", { t, w, purpose }, () => undefined),
      close: async (t, w) => call("frontend", "close", { t, w }, () => undefined),
      removeWorkspace: async (i) => call("frontend", "removeWorkspace", i, () => undefined),
    },
    delivery: {
      id: "github-pr",
      probe: async (i) => call("delivery", "probe", i.contact.ticket, () => world.probes.get(i.contact.ticket) ?? null),
      land: async (i) => call("delivery", "land", i.sourceBranch, () => ({ outcome: "landed" as const, via: "pr" as const })),
    },
  };
  return { ports, calls, world, count: (key: string) => calls.filter((c) => `${c.port}.${c.method}` === key).length };
}

/** A Run for tests that must never spawn: any call fails loudly. */
export const noRun: Run = async (command, args) => {
  throw new Error(`unexpected spawn: ${command} ${args.join(" ")}`);
};
