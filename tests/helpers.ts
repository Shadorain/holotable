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
import type { Evaluation } from "../src/core/evaluation.ts";
import type { OperationReport, ReportContact } from "../src/core/report.ts";
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

/** One fully-typed evaluation for compare/archive tests; override only what the case varies. */
export function evaluation(over: Partial<Evaluation> = {}): Evaluation {
  const dist = { n: 0, medianMs: null, p90Ms: null };
  return {
    v: 1, asOf: 0, deliveredWork: 0, throughputPerHour: null,
    queue: { ...dist }, queued: { n: 0, totalMs: 0, maxMs: null },
    delivery: { ...dist }, lead: { ...dist }, unfinished: { n: 0, totalMs: 0, maxMs: null },
    dependencyWaitMs: null, phaseMs: {}, gateWaitMs: null, offlineMs: null, deliveryReadyMs: null, holdMs: {},
    connectivity: { observedMs: 0, connectedContactMs: 0, peak: 0, mean: null },
    workers: { coveredMs: 0, nonclosedWorkerMs: 0 },
    attempts: { launches: 0, relaunches: 0, launchFailures: 0, landAttempts: 0, conflicts: 0 },
    fleet: { workerAttempts: 2, workerBeads: 2, redispatches: 0, repairRound: 1, repairLinks: 0, boardResendRequests: 0 },
    usage: {
      basis: "scoped", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      knownCostUsd: 1, costPerDelivered: null,
      missingSources: 0, unsupportedWorkers: 0, pricedMessages: 1, unpricedMessages: 0,
      malformedLines: 0, resets: 0, backlogBytes: 0, coordinatorSessionAssociated: true, partial: false,
    },
    quality: {
      since: T0, recordedPassed: 0, recordedFailed: 0, repeatedFailedRevision: 0,
      mergePreflightFailures: 0, boundaryFailures: 0, reviewFailures: 0, acceptedRepairs: 0,
      completedRounds: 0, invalidatedRounds: 0, findingOccurrences: 0,
      latestActionable: 0, latestRejected: 0, severity: { critical: 0, high: 0, medium: 0, low: 0 },
    },
    config: { value: { graph: "beads", frontend: "subagent", maxWorkers: 1, reviewConcurrency: 1, mode: "auto" }, mixed: false },
    coverage: { timed: 0, launched: 0, usageReported: 0, legacyUsage: 0, producerEvidence: 0, clockAnomalies: 0, counterResets: 0 },
    recommendations: [],
    ...over,
  };
}

/** Minimal duck-typed archived report; stats is unused by comparisons. */
export function reportFixture(over: Partial<OperationReport> = {}): OperationReport {
  return {
    v: 1, id: "trial", name: "Trial", repo: "/repo", base: "main", outcome: "landed",
    createdAt: T0, closedAt: "2026-01-02T00:00:00.000Z", durationMs: 86_400_000,
    counts: { contacts: 0, landed: 0, conflicts: 0, launches: 0, landAttempts: 0 },
    contacts: [], stats: null as unknown as OperationReport["stats"],
    notes: { done: 0, total: 0 }, notesText: null, brief: null,
    ...over,
  };
}

export function reportContact(ticket: string, final: ReportContact["final"], kind = "implement"): ReportContact {
  return { ticket, title: null, description: null, zone: "ops", kind, final, landedVia: final === "landed" ? "manual" : null, landedAt: final === "landed" ? T0 : null, trackerUrl: null, prUrl: null };
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
    ignoreChecks: false,
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
    /** Tickets whose branch is not in the base yet; every other ticket reads as really merged. */
    unmerged: new Map<string, string>(),
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
      verifyMerged: async (i) =>
        call("delivery", "verifyMerged", i.contact.ticket, () => {
          const reason = world.unmerged.get(i.contact.ticket);
          return reason === undefined ? { merged: true as const, detail: "merged" } : { merged: false as const, reason };
        }),
      land: async (i) => call("delivery", "land", i.sourceBranch, () => ({ outcome: "landed" as const, via: "pr" as const })),
    },
  };
  return { ports, calls, world, count: (key: string) => calls.filter((c) => `${c.port}.${c.method}` === key).length };
}

/** A Run for tests that must never spawn: any call fails loudly. */
export const noRun: Run = async (command, args) => {
  throw new Error(`unexpected spawn: ${command} ${args.join(" ")}`);
};
