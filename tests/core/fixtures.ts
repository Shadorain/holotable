import type {
  Contact,
  ContactStatus,
  Event,
  Lane,
  Operation,
  Measurements,
  UsageEvidence,
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
    description: null,
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
    ignoreChecks: false,
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

export function makeMeasurements(overrides:Partial<Measurements>={}):Measurements {
  return {v:1,since:iso(0),recordedPassed:0,recordedFailed:0,repeatedFailedRevision:0,mergePreflightFailures:0,boundaryFailures:0,reviewFailures:0,acceptedRepairs:0,completedRounds:0,invalidatedRounds:0,findingOccurrences:0,latestActionable:0,latestRejected:0,severity:{critical:0,high:0,medium:0,low:0},workerAttempts:2,workerBeads:2,repairRound:1,repairLinks:0,config:{graph:"beads",frontend:"subagent",maxWorkers:2,reviewConcurrency:1,mode:"auto"},...overrides};
}
export function makeUsageEvidence(input:number,costUsd:number|null=input/100):UsageEvidence {
  return {v:1,measuredAt:iso(input),sources:[{role:"coordinator",id:"coordinator:shared",tokens:{input,output:0,cacheRead:0,cacheWrite:0},costUsd,sessions:1,pricedMessages:costUsd===null?0:1,unpricedMessages:costUsd===null?1:0}],missing:0,unsupportedWorkers:0,malformedLines:0,resets:0,backlogBytes:0,partial:costUsd===null};
}
