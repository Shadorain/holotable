import type {
  Contact,
  ContactStatus,
  Event,
  Lane,
  Operation,
} from "../../src/core/types.ts";

export const T0 = Date.UTC(2026, 0, 1);

export const iso = (ms: number): string => new Date(T0 + ms).toISOString();

export function makeContact(
  ticket: string,
  overrides: Partial<Contact> = {},
): Contact {
  return {
    ticket,
    title: null,
    zone: "z1",
    kind: "implement",
    blockedBy: [],
    conflictOf: null,
    lane: null,
    ...overrides,
  };
}

export function makeLane(overrides: Partial<Lane> = {}): Lane {
  return {
    worktree: "/wt",
    branch: "holotable/a",
    frontend: "orca",
    terminal: { handle: "h1", incarnationId: "i1" },
    ...overrides,
  };
}

export function makeOp(
  contacts: Contact[] = [],
  overrides: Partial<Operation> = {},
): Operation {
  return {
    v: 1,
    id: "op1",
    name: "Op One",
    repo: "/repo",
    integration: "/repo",
    base: "main",
    pause: false,
    tracker: "none",
    fleet: "none",
    frontend: "none",
    delivery: "none",
    zones: [{ id: "z1", label: "Zone 1" }],
    contacts,
    project: null,
    createdAt: iso(0),
    recover: false,
    ...overrides,
  };
}

export function makeStatus(
  overrides: Partial<ContactStatus> = {},
): ContactStatus {
  return {
    schema: 1,
    id: "run1",
    ticket: "a",
    title: "t",
    worktree: "/wt",
    base: "main",
    phase: "work",
    progress: { step: 1, of: 4 },
    hold: "none",
    gate: null,
    next: null,
    actions: [],
    workers: null,
    delivery: null,
    complete: false,
    revision: "r1",
    ctl: { socket: "/tmp/x.sock", generation: 1 },
    plan: null,
    mode: null,
    verify: null,
    usage: null,
    updatedAt: iso(1),
    ...overrides,
  };
}

export function ev(
  ms: number,
  contact: string | null,
  kind: Event["kind"],
  extra: Record<string, unknown> = {},
): Event {
  return {
    v: 1,
    at: iso(ms),
    kind,
    ...(contact !== null ? { contact } : {}),
    ...extra,
  } as unknown as Event;
}
