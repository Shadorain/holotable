export const TRACKERS = ["linear", "github", "none"] as const;
export const FLEETS = ["omp-mission", "none"] as const;
export const FRONTENDS = ["orca", "herdr", "custom", "none"] as const;
export const DELIVERIES = ["github-pr", "local-merge", "none"] as const;
export const KINDS = ["implement", "audit", "decision", "conflict"] as const;
export const OPERATOR_OPS = [
  "plan-approve",
  "redecide",
  "decide-agent",
  "approve",
  "continue",
  "mode",
  "review",
  "dispatch",
  "check",
  "resend",
  "retry-model",
  "release",
  "reap",
  "relaunch",
  "clear",
] as const;
export const CONTACT_STATES = [
  "ready",
  "blocked",
  "decision",
  "planning",
  "running",
  "verify",
  "review",
  "hold",
  "complete",
  "conflict",
  "landed",
  "offline",
  "waiting",
] as const;
/** Who created or changed a contact: you (slash command or board), the model's queue tool, a --from seed, or a Land conflict. */
export const SOURCES = ["operator", "model", "seed", "conflict"] as const;
export type Source = (typeof SOURCES)[number];
/** Who caused a history entry. */
export type Actor = "operator" | "model" | "mission" | "board";
export const HOLDS = ["none", "plan-approval", "resume", "gate", "blocked", "quota", "question"] as const;

/** Socket ops beyond the UI-exposed operator set: plan reading (no operator flag) is `FleetPort.readPlan`. */
export const CONTROL_OPS = [...OPERATOR_OPS, "plan-edit", "plan-refine"] as const;

export type Tracker = (typeof TRACKERS)[number];
export type Fleet = (typeof FLEETS)[number];
export type Frontend = (typeof FRONTENDS)[number];
export type Delivery = (typeof DELIVERIES)[number];
export type Kind = (typeof KINDS)[number];
export type ControlOp = (typeof CONTROL_OPS)[number];
export type OperatorOp = (typeof OPERATOR_OPS)[number];
export type ContactState = (typeof CONTACT_STATES)[number];
export type Hold = (typeof HOLDS)[number];

export interface RecoveryWait {
  kind: "capacity" | "memory";
  detail: string;
}

export interface TerminalRef {
  handle: string;
  incarnationId: string;
}
export interface Lane {
  worktree: string;
  branch: string | null;
  frontend: Frontend | "external";
  terminal: TerminalRef | null;
  /** Explicit launch model override; null resets to OMP default. */
  model?: string | null;
}
export interface Zone {
  id: string;
  label: string;
}
export interface Contact {
  ticket: string;
  title: string | null;
  description?: string | null;
  zone: string;
  kind: Kind;
  blockedBy: string[];
  conflictOf: string | null;
  lane: Lane | null;
  /** 2..8 short strings, each 1..120 chars, unique; only for kind="decision". */
  options?: string[];
  /** Must be one of options. */
  recommended?: string;
}
/** A project's identity is its id; its settings seed every operation that names it. */
export interface Project {
  v: 1;
  id: string;
  name: string;
  repo: string;
  base: string;
  integration: string;
  pause: boolean;
  tracker: Tracker;
  fleet: Fleet;
  frontend: Frontend;
  delivery: Delivery;
  /** Land PRs whose checks are failing (CI that is often red for unrelated reasons). Branch protection still applies. */
  ignoreChecks: boolean;
  createdAt: string;
  worktreeRoot?: string;
}
/** Fields an operation may carry itself or inherit from its project (an absent key = inherit). */
export const OVERRIDABLE_FIELDS = [
  "repo",
  "base",
  "integration",
  "pause",
  "tracker",
  "fleet",
  "frontend",
  "delivery",
  "worktreeRoot",
  "ignoreChecks",
] as const;
export type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];
/** operation.json on disk: with `project` set, any overridable key may be absent to inherit it. */
export interface StoredOperation {
  v: 1;
  id: string;
  name: string;
  project: string | null;
  repo?: string;
  base?: string;
  integration?: string;
  pause?: boolean;
  tracker?: Tracker;
  fleet?: Fleet;
  frontend?: Frontend;
  delivery?: Delivery;
  worktreeRoot?: string;
  ignoreChecks?: boolean;
  zones: Zone[];
  contacts: Contact[];
  createdAt: string;
  auto?: AutoMode;
  /** Recovery (relaunch dead panes, continue resume holds); absent = off. Never inherited. */
  recover?: boolean;
}
export interface Operation {
  v: 1;
  id: string;
  name: string;
  repo: string;
  base: string;
  integration: string;
  pause: boolean;
  tracker: Tracker;
  fleet: Fleet;
  frontend: Frontend;
  delivery: Delivery;
  /** See Project.ignoreChecks; operations written before it existed do not ignore checks. */
  ignoreChecks: boolean;
  zones: Zone[];
  contacts: Contact[];
  createdAt: string;
  /** The project this operation inherits unset overridable fields from; null = standalone. */
  project: string | null;
  /** Overrides settings.worktrees.root for this operation's git-managed lanes (herdr, custom). */
  worktreeRoot?: string;
  /** Auto mode; absent until first enabled. See runtime/auto.ts. */
  auto?: AutoMode;
  /** Recovery mode: the board relaunches dead panes and continues resume holds. See runtime/recover.ts. */
  recover: boolean;
}
export interface AutoMode {
  enabled: boolean;
  launch: boolean;
  land: boolean;
  /** Live missions this operation may run at once, 1-64. */
  maxLive: number;
  plans: boolean;
  decide: boolean;
}
/** `auto` on an operation; `auto.launch`/`auto.land`/`auto.maxLive`/`auto.plans`/`auto.decide` tune it. */
export const AUTO_FIELDS = ["auto", "auto.launch", "auto.land", "auto.maxLive", "auto.plans", "auto.decide"] as const;

// ---- events (C3) ----

export interface UsageTotals {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number | null;
  sessions: number;
}
/** The mission's mode; older producers omit it from the status file. */
export type Mode = "auto" | "pause" | "force";
export const MODES = ["auto", "pause", "force"] as const;

export interface SampleFields {
  tracker?: { state: string; url: string | null };
  delivery?: { url: string | null; state: string; mergeable: string; checks: string };
  workers?: number;
  omp?: number;
  /** Sampled from status.usage when it changes; sessions stays status-side. */
  usage?: { tokens: UsageTotals["tokens"]; costUsd: number | null };
}
interface EventBase {
  v: 1;
  at: string;
}
interface ContactEventBase extends EventBase {
  contact: string;
}
export type LaunchStep = "repo" | "workspace" | "terminal" | "socket";
export type ClosedOutcome = "landed" | "abandoned" | "decision" | "failed";
export type Event =
  | (ContactEventBase & { kind: "queued"; source?: Source })
  | (ContactEventBase & { kind: "edited"; source: Source; fields: string[] })
  | (ContactEventBase & { kind: "blocked"; by: string[] })
  | (ContactEventBase & { kind: "unblocked" })
  | (ContactEventBase & { kind: "adopted"; worktree: string; source?: Source })
  | (ContactEventBase & { kind: "launched"; worktree: string; frontend: Frontend; terminal: TerminalRef })
  | (ContactEventBase & { kind: "launch-failed"; step: LaunchStep; error: string })
  | (ContactEventBase & { kind: "socket-up"; generation: number })
  | (ContactEventBase & { kind: "socket-down" })
  | (ContactEventBase & { kind: "phase"; from: string | null; to: string })
  | (ContactEventBase & { kind: "gate-armed"; gate: string })
  | (ContactEventBase & { kind: "decided"; choice: string; rationale?: string; by: "operator" | "agent" | "recommended" })
  | (ContactEventBase & { kind: "operator"; op: string; ok: boolean; error?: string; by?: "auto" | "recover"; args?: Record<string, unknown> })
  | (ContactEventBase & { kind: "land-attempt"; outcome: "clean" | "conflict"; paths?: string[] })
  | (ContactEventBase & { kind: "conflict-opened"; conflictContact: string })
  | (ContactEventBase & { kind: "landed"; via: "merge" | "pr" | "manual" })
  | (ContactEventBase & { kind: "reaped" })
  | (ContactEventBase & ({ kind: "sample" } & SampleFields))
  | (ContactEventBase & { kind: "removed"; worktree: string })
  | (EventBase & { kind: "auto"; enabled: boolean; reason?: string; by: "operator" | "board" })
  | (EventBase & { kind: "workflow"; item: string; done: boolean })
  | (EventBase & { kind: "recover"; enabled: boolean; by: "operator" | "board" })
  | (EventBase & { kind: "closed"; outcome: ClosedOutcome });
export type EventKind = Event["kind"];
export const CONTACT_EVENT_KINDS = [
  "queued",
  "edited",
  "blocked",
  "unblocked",
  "adopted",
  "launched",
  "removed",
  "launch-failed",
  "socket-up",
  "socket-down",
  "phase",
  "gate-armed",
  "decided",
  "operator",
  "land-attempt",
  "conflict-opened",
  "landed",
  "reaped",
  "sample",
] as const;
export const OPERATION_EVENT_KINDS = ["workflow", "closed", "auto", "recover"] as const;

// ---- settings (C4) ----

export const THEMES = ["holo", "omp", "slate"] as const;
export type Theme = (typeof THEMES)[number];
export const ACCESS_MODES = ["local", "tailscale", "network"] as const;
export type Access = (typeof ACCESS_MODES)[number];

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AiSettings {
  model: string | null;
  thinking: string | null;
  draft: string | null;
  decision: string | null;
  mission: string | null;
}

export interface ModelCost {
  input: number;
  output: number;
}

export interface ModelCapacity {
  state: "available" | "low" | "exhausted" | "unknown";
  remainingFraction: number | null;
  resetAt: number | null;
  checkedAt: number | null;
  detail: string;
}

export interface SubscriptionCapacity extends ModelCapacity {
  provider: string;
  label: string;
  windows: Array<{ label: string; remainingFraction: number | null; resetAt: number | null }>;
}

export interface ModelEntry {
  selector: string;
  name: string;
  provider: string;
  cost?: ModelCost;
  reasoning?: boolean;
  capacity?: ModelCapacity;
}

export interface ModelsResult {
  models: ModelEntry[];
  error?: string;
  subscriptions?: SubscriptionCapacity[];
  usageError?: string;
}

export interface Settings {
  access: Access;
  port: number;
  cap: number;
  pollMs: number;
  sampleMs: number;
  theme: Theme;
  /** Folder template for lanes holotable creates with git itself; see core/worktrees.ts. */
  worktrees: { root: string };
  defaults: { tracker: Tracker; fleet: Fleet; frontend: Frontend; delivery: Delivery; pause: boolean };
  custom?: { terminal?: string; focus?: string; close?: string };
  /** After a contact lands, close its pane and remove its worktree. */
  cleanup: boolean;
  ai: AiSettings;
}

// ---- fleet contract (C5) ----

/** The mission's latest verification outcome; older producers omit the field. */
export type Verify = "pending" | "active" | "passed" | "failed" | "skipped";
export const VERIFIES = ["pending", "active", "passed", "failed", "skipped"] as const;

export interface MissionProblem {
  kind: "quota" | "rate-limit" | "timeout" | "error";
  source: string;
  detail: string;
  retryAt: string | null;
  attempt: number | null;
  completed: number | null;
  total: number | null;
}

/** Producer's latest PR check (omp-mission `/mission check`); absent from older panes. */
export interface MissionCheck {
  at: string;
  state: "clean" | "merged" | "closed" | "conflict" | "threads" | "checks" | "fixing" | "unknown";
  detail: string;
  conflicts: string[];
  threads: { open: number; total: number };
}

export interface ContactStatus {
  schema: 1;
  id: string;
  ticket: string;
  title: string;
  worktree: string;
  base: string | null;
  phase: string;
  progress: { step: number; of: number } | null;
  hold: Hold;
  gate: { kind: string; id: string } | null;
  next: string | null;
  actions: string[];
  workers: { live: number; total: number } | null;
  delivery: { url: string | null; branch: string | null } | null;
  complete: boolean;
  revision: string;
  /** Written plan awaiting approval; `null` (or absent from older producers) otherwise. */
  plan: { path: string; revision: string } | null;
  /** The mission's current mode (or the planned mode while a plan pends); null when unknown. */
  mode: Mode | null;
  /** Token/cost usage across coordinator and workers; null until the producer has numbers. */
  usage: UsageTotals | null;
  /** Latest verification outcome; 'failed' means `continue` would re-open broken work. */
  verify: Verify | null;
  problem?: MissionProblem | null;
  check?: MissionCheck | null;
  ctl: { socket: string; generation: number } | null;
  updatedAt: string;
}

// ---- delivery (C6) ----

export interface DeliveryProbe {
  url: string | null;
  state: "open" | "merged" | "closed";
  mergeable: "clean" | "conflict" | "unknown";
  checks: "pass" | "fail" | "pending" | "none";
  /** Names of failed checks, when the delivery reports them. */
  failing?: string[];
}

// ---- derived state (C7) ----

export interface Span {
  from: number;
  to: number | null;
}
export interface ContactDerived {
  queuedAt: number | null;
  launchedAt: number | null;
  landed: boolean;
  landedAt: number | null;
  reaped: boolean;
  lastPhase: string | null;
  phaseSpans: Array<Span & { phase: string }>;
  gateSpans: Array<Span & { gate: string }>;
  socketEver: boolean;
  socketUp: boolean;
  downSpans: Span[];
  landAttempts: number;
  conflicts: number;
  launchFailed: { step: LaunchStep; error: string } | null;
  lastSample: SampleFields | null;
  lastOmp: number | null;
  /** The lane's worktree was deleted after landing (settings.cleanup). */
  removed: boolean;
  decision: { choice: string; rationale: string | null; by: "operator" | "agent" | "recommended"; at: string } | null;
}
export interface Derived {
  contacts: Record<string, ContactDerived>;
  peakOmp: number;
  closed: boolean;
}

export type Owner = "live" | "offline" | "none";
export interface Load {
  live: number;
  open: number;
}

export interface ActionView {
  id: string;
  label: string;
  primary: boolean;
  enabled: boolean;
  reason: string | null;
}

export interface PolicyInput {
  operation: Operation;
  contact: Contact;
  derived: Derived;
  state: ContactState;
  status: ContactStatus | null;
  owner: Owner;
  probe: DeliveryProbe | null;
  load: Load;
  cap: number;
  /** Ticket of an unresolved conflict contact for `contact`, if any. */
  conflictOpen: string | null;
  decisionPaneOpen: boolean;
  recoveryWait?: RecoveryWait;
  terminalMissing?: boolean;
}

export interface Stats {
  queueWaitMs: Record<string, number>;
  queueWaitAvgMs?: number;
  phaseMs: Record<string, number>;
  gateWaitMs?: number;
  landAttempts: number;
  conflicts: number;
  conflictRate?: number;
  socketDownMs?: number;
  omp: { current: number; peak: number };
  /** Summed across contacts' latest usage samples; absent when no contact reported usage. */
  tokens?: UsageTotals["tokens"];
  /** Summed non-null contact costs; absent when no contact reported a cost. */
  costUsd?: number;
}

export interface ProjectionInput {
  operation: Operation;
  /** {id,name} when the operation sits in a project; resolved by the caller, the projection stays pure. */
  project: { id: string; name: string } | null;
  events: Event[];
  statuses: Record<string, ContactStatus | null>;
  owners: Record<string, Owner>;
  probes: Record<string, DeliveryProbe | null>;
  /** notes.md text, null when absent; task lines counted for `notes`. */
  notesText: string | null;
  load: Load;
  cap: number;
  decisionPanes?: ReadonlySet<string>;
  recoveryWaits?: Readonly<Record<string, RecoveryWait>>;
  vanished?: ReadonlySet<string>;
  /** Uncommitted path count in the integration checkout; null when not probed. */
  integrationDirty?: number | null;
  now: number;
}

export interface HistoryEntry {
  at: string;
  kind: EventKind;
  contact: string | null;
  actor: Actor;
  cls: "ok" | "err" | "";
  text: string;
}

export interface ContactView {
  ticket: string;
  title: string | null;
  description?: string | null;
  zone: string;
  /** For a conflict contact, the ticket whose merge it resolves; null otherwise. */
  conflictOf: string | null;
  /** Present while a pending plan awaits approval (status.plan): {revision}; text is GET /api/plan. */
  plan: { revision: string } | null;
  options?: string[];
  recommended?: string;
  decision: { choice: string; rationale: string | null; by: "operator" | "agent" | "recommended"; at: string } | null;
  decisionPane: boolean;
  kind: Kind;
  group: "queue" | "live";
  state: ContactState;
  detail: string;
  problem?: MissionProblem | null;
  /** Latest PR check the producer reported; null until the first /mission check. */
  check?: MissionCheck | null;
  progress: { step: number; of: number } | null;
  phase: string | null;
  blockedBy: Array<{ ticket: string; landed: boolean }>;
  tracker: { state: string; url: string | null } | null;
  delivery: { url: string | null; state: string; mergeable: string; checks: string } | null;
  workers: { live: number; total: number } | null;
  owner: Owner;
  origin: { actor: Actor; at: string; text: string } | null;
  /** The mission's mode from its status; null while queued or unreported. */
  mode: Mode | null;
  /** Latest reported usage (sampled when it changes); null until the producer reports. */
  usage: UsageTotals | null;
  /** Where the mission runs; null while queued. */
  lane: { worktree: string; branch: string | null; frontend: Lane["frontend"]; terminal: boolean } | null;
  /** The operator has something to do here now (approve, land, decide, recover). */
  attention: boolean;
  actions: ActionView[];
}

export interface Projection {
  operation: {
    id: string;
    name: string;
    base: string;
    frontend: Frontend;
    tracker: Tracker;
    fleet: Fleet;
    auto: (AutoMode & { landWait?: string | null; capacityWait?: string | null }) | null;
    recover: boolean;
    delivery: Delivery;
    pause: boolean;
    project: { id: string; name: string } | null;
    zones: Array<Zone & { angle: number }>;
    /** Uncommitted path count in the integration checkout (local-merge); null when not probed. */
    integrationDirty: number | null;
  };
  header: { live: number; open: number; cap: number };
  contacts: ContactView[];
  /** Task lines in notes.md: checked over total; {done:0,total:0} without a notes file. */
  notes: { done: number; total: number };
  selection: string | null;
  stats: Stats;
  /** Newest first, at most 50; the full list is GET /api/history. */
  log: HistoryEntry[];
}
