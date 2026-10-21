import type {
  Contact,
  ContactStatus,
  ControlOp,
  Delivery,
  DeliveryProbe,
  Fleet,
  Frontend,
  Operation,
  TerminalRef,
  Tracker,
} from "./core/types.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}
// Real Run: omp-mission/src/extension.ts pattern: env -> `env K=V cmd`, pi.exec(command, args, {cwd, timeout, signal}), code ?? 1.
export type Run = (
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
) => Promise<CommandResult>;

export class PortError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PortError";
  }
}

export interface TrackerHit {
  ticket: string;
  title: string;
  state: string | null;
  url: string | null;
}

export interface TrackerPort {
  readonly id: Tracker;
  sample(ticket: string, cwd: string): Promise<{ state: string; url: string | null } | null>;
  /** null: the tracker cannot search (CLI missing, auth, non-zero exit). [] is a valid no-match answer. */
  search(query: string, cwd: string, limit: number): Promise<TrackerHit[] | null>;
}


/** `setup`: the frontend's own tab running the worktree's setup hook, never an agent session. */
export type ListedTerminal = TerminalRef & { worktree: string; connected: boolean; agent?: string | null; setup?: boolean };

export interface WorkspaceInput {
  repo: string;
  name: string;
  base: string;
  ticket: string | null;
  /** local-merge lands without pushing, so git-managed lanes prefer the local base ref. */
  delivery?: Delivery;
}

export interface TerminalCommand {
  argv: string[];
  env: Record<string, string>;
}

export interface FrontendPort {
  readonly id: Frontend;
  ensureRepo(repo: string): Promise<void>;
  createWorkspace(i: WorkspaceInput): Promise<{ worktree: string; branch: string | null }>;
  /** Startup runs in the new checkout; relative paths in its command resolve there. */
  createWorkspaceWithTerminal?(i: WorkspaceInput & { startup: TerminalCommand }): Promise<{
    worktree: string;
    branch: string | null;
    terminal: TerminalRef;
  }>;
  openTerminal(i: {
    worktree: string;
    title: string;
    argv: string[];
    env: Record<string, string>;
  }): Promise<TerminalRef>;
  /** null: the frontend cannot list terminals. */
  listTerminals(): Promise<ListedTerminal[] | null>;
  /** Bring the terminal forward. `purpose` is advisory (e.g. "plan-approval"); frontends may ignore it. */
  focus(t: TerminalRef, worktree: string, purpose?: string): Promise<void>;
  close(t: TerminalRef, worktree: string): Promise<void>;
  removeWorkspace(i: { repo: string; worktree: string }): Promise<void>;
}

export interface FleetPort {
  readonly id: Fleet;
  launch(i: {
    operation: Operation;
    contact: Contact;
    worktree: string;
    /** YAML overlay that puts the new session into plan mode at startup. */
    overlay: string;
    conflictPaths?: string[];
    model?: string | null;
    thinking?: string | null;
  }): { argv: string[]; env: Record<string, string> };
  read(i: { worktree: string }): Promise<ContactStatus | null>;
  ping(status: ContactStatus): Promise<boolean>;
  /** Process identity, independent of status freshness/socket authority; null when unavailable. */
  running(status: ContactStatus): Promise<boolean | null>;
  /** The pending plan's text while hold is "plan-approval"; null when there is none (`no-plan`). */
  readPlan(status: ContactStatus): Promise<{ text: string; path: string; revision: string } | null>;
  control(status: ContactStatus, op: ControlOp, args: Record<string, unknown>): Promise<void>;
}

export type MergeVerdict = { merged: true; detail: string } | { merged: false; reason: string };

export type LandResult =
  | { outcome: "landed"; via: "merge" | "pr" }
  | { outcome: "conflict"; paths: string[]; deliveredSha: string; baseSha: string };

export interface DeliveryPort {
  readonly id: Delivery;
  probe(i: {
    operation: Operation;
    contact: Contact;
    status: ContactStatus;
  }): Promise<DeliveryProbe | null>;
  /**
   * Whether `branch`'s work is really in the operation's base. The only authority for recording `landed`:
   * Land, Mark done and auto mode all ask it, so an open PR or an unmerged branch never counts as landed.
   */
  verifyMerged(i: { operation: Operation; contact: Contact; branch: string; url?: string | null }): Promise<MergeVerdict>;
  land(i: {
    operation: Operation;
    contact: Contact;
    sourceBranch: string;
    status: ContactStatus;
    /** Merge even when PR checks are failing (the operation's setting or Land anyway); absent = enforce checks. */
    ignoreChecks?: boolean;
  }): Promise<LandResult>;
  /**
   * Open a review for `branch`'s unmerged work when the mission delivered none (an audit that committed
   * code). Deliveries without reviews omit it. Returns the review URL.
   */
  publish?(i: { operation: Operation; contact: Contact; branch: string }): Promise<{ url: string }>;
}

export interface Ports {
  tracker: TrackerPort;
  fleet: FleetPort;
  frontend: FrontendPort;
  delivery: DeliveryPort;
}
