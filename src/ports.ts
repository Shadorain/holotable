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


/**
 * `session: false`: the frontend knows the row is not an agent session (its setup-hook tab, an idle shell).
 * Absent or true: it is, or may be, one.
 */
export type ListedTerminal = TerminalRef & { worktree: string; connected: boolean; session?: boolean };

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
  /** Native structured frontends apply this through the session mode API, not overlay filenames. */
  sessionMode?: "plan" | "default";
}

export interface FrontendPort {
  readonly id: Frontend;
  ensureRepo(repo: string): Promise<void>;
  /** `worktreeId` is the frontend's host-unique checkout id (Orca `<repoId>::<path>`) when it has one. */
  createWorkspace(i: WorkspaceInput): Promise<{ worktree: string; branch: string | null; worktreeId?: string }>;
  /** Startup runs in the new checkout; relative paths in its command resolve there. */
  createWorkspaceWithTerminal?(i: WorkspaceInput & { startup: TerminalCommand }): Promise<{
    worktree: string;
    branch: string | null;
    worktreeId?: string;
    terminal: TerminalRef;
  }>;

  /** `worktreeId` (when recorded) disambiguates a checkout whose path also exists on other hosts. */
  openTerminal(i: {
    worktree: string;
    title: string;
    argv: string[];
    env: Record<string, string>;
    sessionMode?: "plan" | "default";
    worktreeId?: string;
  }): Promise<TerminalRef>;
  /** null: the frontend cannot list terminals. */
  listTerminals(): Promise<ListedTerminal[] | null>;
  /** Bring the terminal forward. `purpose` is advisory (e.g. "plan-approval"); frontends may ignore it. */
  focus(t: TerminalRef, worktree: string, purpose?: string): Promise<void>;
  close(t: TerminalRef, worktree: string): Promise<void>;
  /** Only an operator-confirmed Abort may force removal; normal cleanup must preserve local changes. */
  removeWorkspace(i: { repo: string; worktree: string; worktreeId?: string; force?: boolean }): Promise<void>;
}

export interface FleetPort {
  readonly id: Fleet;
  /**
   * Remote fleets only: staged before launch so `launch` never touches the board host's filesystem.
   * Implementations deploy shared artifacts (mission relay, launch config) and return the path the
   * mission host must see as `launch`'s `overlay`. Absent on local fleets.
   */
  prepare?(i: { kind: "plan" | "resume" }): Promise<{ overlay: string }>;

  launch(i: {
    operation: Operation;
    contact: Contact;
    worktree: string;
    /** YAML overlay that puts the new session into plan mode at startup. */
    overlay: string;
    conflictPaths?: string[];
    /** A closer's generated review brief (`core/closer.ts`); required for kind "closer". */
    closerBrief?: string;
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
  publish?(i: { operation: Operation; contact: Contact; branch: string; body: string }): Promise<{ url: string }>;
}

export interface Ports {
  tracker: TrackerPort;
  fleet: FleetPort;
  frontend: FrontendPort;
  delivery: DeliveryPort;
  /**
   * Executes on the operation's execution host: locally for local operations, through the
   * authenticated remote transport for placed ones. Any argv; the runtime uses it for
   * file/git/cleanup/landing work in operation paths (never the ambient board run there).
   */
  run: Run;
}
