import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { usableMemoryBytes } from "./machine.ts";
import { asInput } from "./core/errors.ts";
import { zoneIdFor } from "./core/zones.ts";
import { PANE_MEMORY_BYTES } from "./core/policy.ts";
import { workspaceInfo, type WorkspaceInfo } from "./adapters/workspace-info.ts";
import { doltState, installDolt, restartDolt, type DoltState } from "./adapters/beads-dolt.ts";
import {
  applyOperationField,
  applyProjectField,
  CLOSE_OUTCOMES,
  createFromSpec,
  PROJECT_FIELDS,
  recordConfigToggles,
  SET_FIELDS,
  type NewOperationSpec,
} from "./commands.ts";
import { addContact as addContactStore, type NewContact } from "./contacts.ts";
import { history } from "./core/projection.ts";
import { closerOf } from "./core/closer.ts";
import { archivedCloserView, closerView, type CloserReportView, type CloserView } from "./runtime/closer.ts";
import { readContactReport } from "./store/reports.ts";
import type { UsageReport } from "./core/usage.ts";
import { evaluateOperation, type Evaluation } from "./core/evaluation.ts";
import { computeRollup, type IntelRollup, type RollupEntry } from "./core/rollup.ts";
import type { OperationReport } from "./core/report.ts";
import {
  DELIVERIES,
  FLEETS,
  FRONTENDS,
  OVERRIDABLE_FIELDS,
  THEMES,
  TRACKERS,
  type AutoMode,
  type ClosedOutcome,
  type Frontend,
  type HistoryEntry,
  type MissionReport,
  type Operation,
  type Project,
  type Projection,
  type ModelsResult,
  type Settings,
  type RecoveryWait,
  type Tracker,
} from "./core/types.ts";
import { createModelCatalog } from "./models.ts";
import { createDraftDir, draftEntry, listDrafts, MAX_DRAFT_INPUT, newDraftId, readDraftDoc, readDraftUsage, recordDraftTerminal, recordDraftUsage, removeDraft } from "./store/drafts.ts";
import { draftPrompt } from "./store/draft-prompts.ts";
import { withTimeout } from "./timeout.ts";
import { draftDir, isDraftId } from "./paths.ts";
import { validateProject } from "./core/validate-project.ts";
import { normalizeTicket } from "./core/validate-operation.ts";
import type { FrontendPort, Run, TrackerHit, TrackerPort } from "./ports.ts";
import { listArchive, readArchive, readArchiveReport } from "./store/archive.ts";
import { readBrief, writeBrief } from "./store/brief.ts";
import { readEvents, readFolded } from "./store/events.ts";
import { displaySettingsPath, setSettingKey } from "./settings.ts";
import { readBoardInfo } from "./store/board.ts";
import { mutateSettings, readSettings } from "./store/settings.ts";
import { readNotes, StaleRevisionError, writeNotes } from "./store/notes.ts";
import { createProject, listProjects, mutateProject, readProjectOrNull, removeProjectDir } from "./store/projects.ts";
import { loadProjection, type ProjectionExtras } from "./snapshot.ts";
import { listOperations, mutateOperation, operationsUsingProject, readOperation, readOperationDoc } from "./store/operations.ts";
import type { AbortPreview } from "./runtime/end.ts";
import { runSetupChecks, type SetupReport } from "./setup.ts";
import { detectRepo, listRepoRows, type DetectedFields, type DetectionResult, type RepoRow } from "./adapters/detector.ts";
import { readRecentRepos } from "./store/recent-repos.ts";
import { createRun } from "./run.ts";

export type { RepoRow, DetectionResult, DetectedFields };

const WORKSPACE_TTL_MS = 60_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface OperationSummary {
  id: string;
  name: string;
  project: { id: string; name: string } | null;
  live: number;
  queued: number;
  attention: number;
}
export interface SettingsView {
  settings: Settings;
  /** Where the file lives, for the operator; `~/` when under home. */
  path: string;
  themes: string[];
  /** The Custom frontend section matters only when something actually uses it. */
  customInUse: boolean;
  machine: {
    memoryGb: number;
    ompGb: number;
  };
  urls: string[];
}
export interface OperationConfig {
  fields: {
    name: string;
    base: string;
    integration: string;
    pause: boolean;
    ignoreChecks: boolean;
    tracker: string;
    fleet: string;
    frontend: string;
    delivery: string;
    worktreeRoot: string;
    auto: AutoMode | null;
    recover: boolean;
    /** The operation's project id, "" while standalone. */
    project: string;
  };
  /** Field names taken from the project (empty when standalone). */
  inherited: string[];
  options: { tracker: string[]; fleet: string[]; frontend: string[]; delivery: string[] };
  workspace: WorkspaceInfo;
}
export interface ActionRequest {
  op: string;
  contact: string;
  action: string;
  args: Record<string, unknown>;
  /** Set by auto mode or recovery: the action is recorded as the board's, not the operator's. */
  by?: "auto" | "recover";
}

export interface TrackerSearchResult {
  tracker: Tracker;
  hits: Array<TrackerHit & { taken?: true }>;
  /** Why no hits came back (tracker down, timed out); absent on a clean answer. */
  error?: string;
}

/** What the HTTP server needs from the board. Optional members exist only once their runtime does. */
export interface BoardService {
  operations(): Promise<OperationSummary[]>;
  /** Create an operation from the same spec `/holotable new` uses. */
  createOperation?(spec: NewOperationSpec): Promise<Operation>;
  projection(opId: string): Promise<Projection>;
  intelSources(): Promise<{ operations: Array<{ id: string; name: string }>; archives: Array<{ key: string; id: string; name: string; closedAt: string }> }>;
  intel(selection: { op: string } | { archive: string }): Promise<IntelSnapshot>;
  /** Ranked cross-operation failure/wait/cost rollup; folds open ops, reuses archive evaluations. */
  intelRollup(): Promise<IntelRollup>;
  /** Every human-readable event of the operation, newest first. */
  history(opId: string): Promise<HistoryEntry[]>;
  /** Run one watcher pass for the operation now. */
  refresh?(opId: string): Promise<void>;
  /** Run an operator action. The server has already checked it is enabled in a fresh projection. */
  action?(req: ActionRequest): Promise<void>;
  /** Re-read mission state after an action so the response reflects it (no stale buttons until the next poll). */
  settle?(opId: string): Promise<void>;
  settings(): Promise<SettingsView>;
  /** Same keys and validation as `/holotable config`; bad values are a 400. */
  setSetting(key: string, value: string | null): Promise<SettingsView>;
  operationConfig(opId: string): Promise<OperationConfig>;
  /** Same fields and validation as `/holotable set`, plus `project` and the `inherit` value; bad values are a 400. */
  setOperationField(opId: string, field: string, value: string): Promise<OperationConfig>;
  /** The pending plan text of a contact awaiting plan-approval; null when none. */
  plan?(opId: string, ticket: string): Promise<{ text: string; path: string; revision: string } | null>;
  /** Live CPU/memory for the Load tooltip; null `op` answers only `all`+`machine`. */
  usage?(opId: string | null): Promise<UsageReport>;
  brief(opId: string): Promise<{ brief: string | null; seed: { text: string } | null; createdAt: string }>;
  setBrief(opId: string, text: string): Promise<void>;
  /** The operation's closer: its review brief as it would launch now, its report and ticket coverage once written; null without one. */
  closer(opId: string): Promise<CloserView | null>;
  /** A contact's mission report: the saved one (kept after it lands), else its live status's. */
  report(opId: string, ticket: string): Promise<{ ticket: string; report: MissionReport | null }>;
  /** `zone` subcommand over HTTP. */
  /** Adds a zone; its id is derived from the label. Returns the id. */
  addZone(opId: string, label: string): Promise<string>;
  /** `add` over HTTP: source is always the operator. */
  addContact(opId: string, input: NewContact): Promise<{ ticket: string; adopted: boolean }>;
  /** Ticket search for the Add contact dialog: op (or project for the create form) names the tracker. */
  trackerSearch(input: { op?: string | null; project?: string | null; q: string }): Promise<TrackerSearchResult>;
  /** Issue URL for a contact. Null when the operation has no tracker or the tracker has no issue link. Never a pull request. */
  trackerIssue(opId: string, ticket: string): Promise<{ url: string | null }>;
  /** End-of-operation surface, present once the service wires wind-down deps. */
  end?: {
    preview(opId: string): Promise<AbortPreview>;
    abort(opId: string, confirm: string): Promise<{ archived: string }>;
    close(opId: string, outcome: ClosedOutcome): Promise<{ archived: string }>;
  };
  /** Archived operations, newest close first. */
  archive(): Promise<ArchiveSummary[]>;
  /** One archived operation's report, its full history and its closer's review (null without a closer); 404 on an unknown key. */
  archiveReport(key: string): Promise<{ report: OperationReport; history: HistoryEntry[]; closer: CloserReportView | null }>;
  /** Projects on disk (id/name/repo/base plus their open operations). */
  projects(): Promise<ProjectRow[]>;
  /** The project page's config view: fields/options/workspace. */
  projectConfig(id: string): Promise<ProjectConfig>;
  /** Create a project (id from the repo name unless given); returns the id. */
  createProject(input: ProjectSpec): Promise<{ id: string }>;
  /** Same fields and validation as `/holotable project set`; bad values are a 400. */
  setProjectField(id: string, field: string, value: string): Promise<ProjectConfig>;
  /** Put this project's bead-graph Dolt server under a supervised systemd unit and stop `bd` auto-start. */
  installGraphService(id: string): Promise<ProjectConfig>;
  /** Restart that unit when the graph is down. */
  restartGraphService(id: string): Promise<ProjectConfig>;
  /** Delete the project directory; 409 while operations point at it. */
  deleteProject(id: string): Promise<void>;
  /** The notes scratch pad of an operation plus its revision. */
  notes(opId: string): Promise<{ text: string; revision: string }>;
  /** Write notes; a revision that no longer matches is a 409. */
  setNotes(opId: string, text: string, base: string): Promise<{ text: string; revision: string }>;
  /** Open a temporary draft pane for the agent to type into; refused without a pane frontend. */
  createDraft?(input: { text: string; project?: string; repo?: string; model?: string | null }): Promise<{ id: string }>;
  /** One draft's state plus its seed/error when ready or invalid; "missing" when gone. */
  draft(id: string): Promise<DraftInfo>;
  /** Close a draft pane and delete its directory. */
  closeDraft(id: string): Promise<void>;
  /** Drafts left over on disk (id/state/createdAt). */
  listDrafts(): Promise<DraftInfo[]>;
  /** Run first-run setup checks and count store items. Cached ~30s. */
  setup(): Promise<{
    checks: Array<{ id: string; label: string; ok: boolean; detail: string; fix?: string }>;
    counts: { projects: number; operations: number; contacts: number; launched: number };
  }>;
  /** Candidate repos for the project repo picker; cached ~30s. */
  repos(): Promise<RepoRow[]>;
  /** Detect project fields and reasons for a repo path. */
  detect(repo: string): Promise<DetectionResult>;
  /** Model catalog from real omp models CLI; cached ~30s. */
  models(refresh?: boolean, includeUsage?: boolean): Promise<ModelsResult>;
}
export interface ProjectRow {
  id: string;
  name: string;
  repo: string;
  base: string;
  operations: Array<{ id: string; name: string }>;
}
export interface ProjectSpec {
  id?: string;
  name?: string;
  repo: string;
  base?: string;
  integration?: string;
  tracker?: string;
  fleet?: string;
  frontend?: string;
  delivery?: string;
  pause?: boolean;
  ignoreChecks?: boolean;
  worktreeRoot?: string;
}
export interface ProjectConfig {
  fields: {
    name: string;
    repo: string;
    base: string;
    integration: string;
    pause: boolean;
    ignoreChecks: boolean;
    tracker: string;
    fleet: string;
    frontend: string;
    delivery: string;
    worktreeRoot: string;
  };
  options: { tracker: string[]; fleet: string[]; frontend: string[]; delivery: string[] };
  workspace: WorkspaceInfo | null;
  /** The bead-graph Dolt server this project's missions read, when it keeps one. */
  graph: DoltState;
}
export interface DraftInfo {
  id: string;
  state: "running" | "ready" | "invalid" | "missing";
  createdAt: string;
  seed?: { name?: string; brief?: string; notes?: string; zones?: unknown[]; contacts?: unknown[] };
  error?: string;
}
export interface IntelSnapshot {
  id: string;
  name: string;
  closedAt: string | null;
  evaluation: Evaluation | null;
}

export interface ArchiveSummary {
  key: string;
  id: string;
  name: string;
  outcome: OperationReport["outcome"];
  closedAt: string;
  counts: OperationReport["counts"];
}


export function summarize(p: Projection, project: { id: string; name: string } | null = null): OperationSummary {
  return {
    id: p.operation.id,
    name: p.operation.name,
    project,
    live: p.header.live,
    queued: p.contacts.filter((c) => c.group === "queue").length,
    attention: p.contacts.filter((c) => c.attention).length,
  };
}

export interface BoardHooks {
  /** Extra projection inputs (statuses, owners, probes, board-wide load) supplied by the watcher. */
  extras?: (opId: string) => ProjectionExtras;
  recoveryWaits?: (opId: string) => Readonly<Record<string, RecoveryWait>>;
  autoLandWait?: (opId: string) => string | null;
  refresh?: BoardService["refresh"];
  action?: BoardService["action"];
  settle?: BoardService["settle"];
  /** The plan read goes through the fleet socket: the service owns ports, not board.ts. */
  plan?: BoardService["plan"];
  /** Tracker ports live in the service; board.ts resolves them by kind for ticket search. */
  tracker?(kind: Tracker): Promise<TrackerPort>;
  /** Wind-down deps live in the service; board.ts only knows the interface. */
  end?: BoardService["end"];
  /** Frontend ports live in the service; board.ts resolves them by kind for drafts. */
  drafts?: {
    frontend(kind: Frontend, worktreeRoot?: string): Promise<FrontendPort>;
  };
  /** For the workspace panel's `orca repo show` call. */
  run?: Run;
  /** Process sampler (`src/usage.ts`); absent on hosts where /proc sampling is not wired. */
  usage?(opId: string | null): Promise<UsageReport>;
  urls?(): string[];
  now?: () => number;
}

export function createBoardService(home: string, hooks: BoardHooks = {}): BoardService {
  const now = hooks.now ?? Date.now;
  let setupCache: { timestamp: number; result: SetupReport } | null = null;
  let reposCache: { timestamp: number; result: RepoRow[] } | null = null;
  // `orca repo show` spawns Orca's CLI, seconds under the service's CPU quota. Config writes clear it.
  const workspaceCache = new Map<string, { timestamp: number; pending: Promise<WorkspaceInfo> }>();
  async function cachedWorkspaceInfo(op: Operation): Promise<WorkspaceInfo> {
    const settings = await readSettings(home);
    // Only Orca spawns; every other frontend answers from the documents just read.
    if (op.frontend !== "orca") return workspaceInfo(op, settings, hooks.run);
    const key = `${op.frontend}\0${op.repo}`;
    const n = now();
    const hit = workspaceCache.get(key);
    if (hit && n - hit.timestamp < WORKSPACE_TTL_MS) return hit.pending;
    const pending = workspaceInfo(op, settings, hooks.run);
    workspaceCache.set(key, { timestamp: n, pending });
    return pending;
  }
  const modelCatalog = createModelCatalog(hooks.run ?? createRun());
  async function projection(opId: string): Promise<Projection> {
    await knownOperation(opId);
    return loadKnownProjection(opId);
  }
  /** For callers that already listed the operation. */
  async function loadKnownProjection(opId: string): Promise<Projection> {
    const p = await loadProjection(home, opId, await readSettings(home), now(), hooks.extras?.(opId), hooks.recoveryWaits?.(opId));
    if (p.operation.auto?.enabled) p.operation.auto.landWait = hooks.autoLandWait?.(opId) ?? null;
    return p;
  }
  async function knownOperation(opId: string): Promise<void> {
    const known = await listOperations(home);
    if (!known.some((row) => row.id === opId)) throw new HttpError(404, `No open operation "${opId}"`);
  }
  /** 404 for the project a request addresses, 400 for one its body names; a failed read stays a 500. */
  async function existingProject(id: string, status: 400 | 404): Promise<Project> {
    const project = await readProjectOrNull(home, id);
    if (!project) throw new HttpError(status, `No project "${id}"`);
    return project;
  }
  async function settingsView(): Promise<SettingsView> {
    const [settings, rows] = await Promise.all([readSettings(home), listOperations(home)]);
    const customInUse =
      settings.defaults.frontend === "custom" ||
      (await Promise.all(rows.map((row) => readOperation(home, row.id)))).some((op) => op.frontend === "custom");
    const memoryGb = Math.round((usableMemoryBytes() / 1024 ** 3) * 10) / 10;
    const ompGb = Math.round((PANE_MEMORY_BYTES / 1024 ** 3) * 10) / 10;
    const urls = hooks.urls?.() ?? (await readBoardInfo(home))?.urls ?? [];
    return { settings, path: displaySettingsPath(home), themes: [...THEMES], customInUse, machine: { memoryGb, ompGb }, urls };
  }
  async function operationConfig(opId: string): Promise<OperationConfig> {
    await knownOperation(opId);
    const doc = await readOperationDoc(home, opId);
    const op = doc.operation;
    return {
      fields: {
        name: op.name,
        base: op.base,
        integration: op.integration,
        pause: op.pause,
        ignoreChecks: op.ignoreChecks,
        tracker: op.tracker,
        fleet: op.fleet,
        frontend: op.frontend,
        delivery: op.delivery,
        worktreeRoot: op.worktreeRoot ?? "",
        auto: op.auto ?? null,
        recover: op.recover,
        project: op.project ?? "",
      },
      inherited: [...doc.inherited],
      options: { tracker: [...TRACKERS], fleet: [...FLEETS], frontend: [...FRONTENDS], delivery: [...DELIVERIES] },
      workspace: await cachedWorkspaceInfo(op),
    };
  }
  function projectConfigOf(project: Project, workspace: WorkspaceInfo | null, graph: DoltState): ProjectConfig {
    return {
      fields: {
        name: project.name,
        repo: project.repo,
        base: project.base,
        integration: project.integration,
        pause: project.pause,
        ignoreChecks: project.ignoreChecks,
        tracker: project.tracker,
        fleet: project.fleet,
        frontend: project.frontend,
        delivery: project.delivery,
        worktreeRoot: project.worktreeRoot ?? "",
      },
      options: { tracker: [...TRACKERS], fleet: [...FLEETS], frontend: [...FRONTENDS], delivery: [...DELIVERIES] },
      workspace,
      graph,
    };
  }
  /** The project page's lane folder mirrors the operation one: the project stands in for its ops. */
  async function projectConfig(id: string): Promise<ProjectConfig> {
    const project = await existingProject(id, 404);
    const stub = {
      frontend: project.frontend,
      repo: project.repo,
      worktreeRoot: project.worktreeRoot,
    } as Operation;
    const run = hooks.run ?? createRun();
    return projectConfigOf(
      project,
      await cachedWorkspaceInfo(stub),
      await doltState(project.id, project.repo, { run }),
    );
  }
  return {
    projection,
    settings: settingsView,
    async setSetting(key, value) {
      await mutateSettings(home, (current) => setSettingKey(current, key, value));
      workspaceCache.clear();
      return settingsView();
    },
    operationConfig,
    async setOperationField(opId, field, value) {
      await knownOperation(opId);
      if (field === "project") {
        if (value === "") {
          // Detach: the resolved values become the operation's own, so nothing changes in effect.
          await mutateOperation(home, opId, (op) => ({ ...op, project: null }));
          workspaceCache.clear();
          return operationConfig(opId);
        }
        const target = await existingProject(value, 400);
        // Attach means "follow the project": every overridable field takes the project's value,
        // overrides can be set again afterwards. Moving launched work to another repo would strand its worktrees.
        await mutateOperation(home, opId, (op) => {
          if (op.repo !== target.repo && op.contacts.some((c) => c.lane))
            throw new HttpError(409, `${op.id} has launched work in ${op.repo}; project ${target.id} uses ${target.repo}`);
          const next: Operation = { ...op, project: target.id };
          for (const key of OVERRIDABLE_FIELDS) {
            if (key === "worktreeRoot") {
              if (target.worktreeRoot === undefined) delete next.worktreeRoot;
              else next.worktreeRoot = target.worktreeRoot;
            } else (next as unknown as Record<string, unknown>)[key] = target[key];
          }
          return next;
        });
        workspaceCache.clear();
        return operationConfig(opId);
      }
      if (!(SET_FIELDS as readonly string[]).includes(field)) throw new HttpError(400, `Unknown field "${field}"`);
      const before = await readOperationDoc(home, opId);
      // Relative integration paths resolve against the operation's repo: the page has no cwd.
      const next = await mutateOperation(home, opId, (op) => applyOperationField(op, field, value, op.repo, before.project));
      await recordConfigToggles(home, new Date(now()), opId, before.operation, next);
      workspaceCache.clear();
      return operationConfig(opId);
    },
    async history(opId) {
      await knownOperation(opId);
      return history(await readEvents(home, opId)).reverse();
    },
    async operations() {
      const [rows, projects] = await Promise.all([listOperations(home), listProjects(home)]);
      const byId = new Map(projects.map((p) => [p.id, p]));
      return Promise.all(
        rows.map(async (row) => {
          const p = row.project !== null ? byId.get(row.project) : null;
          return summarize(await loadKnownProjection(row.id), p ? { id: p.id, name: p.name } : null);
        }),
      );
    },
    async brief(opId) {
      await knownOperation(opId);
      const op = await readOperation(home, opId);
      const out = await readBrief(home, opId);
      return { ...out, createdAt: op.createdAt };
    },
    async setBrief(opId, text) {
      await knownOperation(opId);
      await writeBrief(home, opId, text);
    },
    async closer(opId) {
      await knownOperation(opId);
      const operation = await readOperation(home, opId);
      const closer = closerOf(operation);
      if (!closer) return null;
      return closerView(home, operation, closer, now());
    },
    async report(opId, ticket) {
      await knownOperation(opId);
      const operation = await readOperation(home, opId);
      if (!operation.contacts.some((contact) => contact.ticket === ticket)) throw new HttpError(404, `No contact "${ticket}"`);
      const saved = await readContactReport(home, opId, ticket);
      return { ticket, report: saved ?? hooks.extras?.(opId).statuses?.[ticket]?.report ?? null };
    },
    async addZone(opId, label) {
      await knownOperation(opId);
      let id = "";
      await mutateOperation(home, opId, (op) => {
        id = zoneIdFor(label, op.zones.map((z) => z.id));
        return { ...op, zones: [...op.zones, { id, label }] };
      });
      return id;
    },
    async addContact(opId, input) {
      await knownOperation(opId);
      return addContactStore(home, new Date(now()), opId, { ...input, source: "operator" });
    },
    async trackerSearch(input) {
      const q = input.q.trim();
      let tracker: Tracker;
      let cwd: string;
      let taken: Set<string> | null = null;
      if (input.op) {
        if (input.project) throw new HttpError(400, "op and project are alternatives");
        await knownOperation(input.op);
        const operation = await readOperation(home, input.op);
        tracker = operation.tracker;
        cwd = operation.repo;
        taken = new Set(operation.contacts.map((c) => normalizeTicket(tracker, c.ticket)));
      } else if (input.project) {
        const project = await existingProject(input.project, 404);
        tracker = project.tracker;
        cwd = project.repo;
      } else {
        throw new HttpError(400, "op or project is required");
      }
      if (tracker === "none" || q.length < 2) return { tracker, hits: [] };
      const port = hooks.tracker ? await hooks.tracker(tracker) : null;
      if (!port) return { tracker, hits: [], error: "no tracker port available" };
      let hits: TrackerHit[] | null;
      try {
        // A failing port answers nothing; only the timer itself reports a timeout.
        hits = await withTimeout((async () => port.search(q, cwd, 8))().catch(() => null), 8_000, "timeout");
      } catch {
        return { tracker, hits: [], error: "timed out after 8 s" };
      }
      if (hits === null) return { tracker, hits: [], error: "tracker answered nothing" };
      return { tracker, hits: taken ? hits.map((h) => (taken.has(normalizeTicket(tracker, h.ticket)) ? { ...h, taken: true as const } : h)) : hits };
    },
    async trackerIssue(opId, ticket) {
      await knownOperation(opId);
      const operation = await readOperation(home, opId);
      if (!operation.contacts.some((contact) => contact.ticket === ticket))
        throw new HttpError(404, `No contact "${ticket}"`);
      if (operation.tracker === "none") return { url: null };
      const port = hooks.tracker ? await hooks.tracker(operation.tracker) : null;
      if (!port) return { url: null };
      const sampled = await withTimeout((async () => port.sample(ticket, operation.repo))(), 8_000, "timeout").catch(() => null);
      const url = sampled?.url;
      if (typeof url !== "string" || !/^https?:\/\//i.test(url) || /\/pull\/\d+(?:[/?#]|$)/i.test(url))
        return { url: null };
      return { url };
    },
    async createOperation(spec) {
      return createFromSpec(home, new Date(now()), spec);
    },
    async intelSources() {
      const [operations, archives] = await Promise.all([listOperations(home), listArchive(home, new Date(now()))]);
      return {
        operations: operations.map(({ id, name }) => ({ id, name })),
        archives: archives.map(({ key, report }) => ({ key, id: report.id, name: report.name, closedAt: report.closedAt })),
      };
    },
    async intel(selection) {
      if ("archive" in selection) {
        const entry = await readArchiveReport(home, selection.archive, new Date(now()));
        if (!entry) throw new HttpError(404, `No archive "${selection.archive}"`);
        const report = entry.report;
        return { id: report.id, name: report.name, closedAt: report.closedAt, evaluation: report.evaluation ?? null };
      }
      await knownOperation(selection.op);
      const [operation, { derived }] = await Promise.all([readOperation(home, selection.op), readFolded(home, selection.op)]);
      return { id: operation.id, name: operation.name, closedAt: null, evaluation: evaluateOperation(operation, derived, now()) };
    },
    async intelRollup() {
      const [operations, archives] = await Promise.all([listOperations(home), listArchive(home, new Date(now()))]);
      const entries: RollupEntry[] = archives.map(({ report }) => ({ name: report.name, closedAt: report.closedAt, source: "archive" as const, evaluation: report.evaluation ?? null }));
      for (const row of operations) {
        try {
          const [operation, { derived }] = await Promise.all([readOperation(home, row.id), readFolded(home, row.id)]);
          entries.push({ name: operation.name, closedAt: null, source: "open", evaluation: evaluateOperation(operation, derived, now()) });
        } catch {
          // An operation that vanishes or fails to fold mid-list counts as missing evidence, not a rollup failure.
          entries.push({ name: row.name, closedAt: null, source: "open", evaluation: null });
        }
      }
      return computeRollup(entries, now(), await readDraftUsage(home));
    },
    async archive() {
      const entries = await listArchive(home, new Date(now()));
      return entries.map((e) => ({ key: e.key, id: e.report.id, name: e.report.name, outcome: e.report.outcome, closedAt: e.report.closedAt, counts: e.report.counts }));
    },
    async archiveReport(key) {
      const entry = await readArchive(home, key, new Date(now()));
      if (!entry) throw new HttpError(404, `No archive "${key}"`);
      const { evaluation: _evaluation, ...report } = entry.report;
      return { report, history: history(entry.events).reverse(), closer: archivedCloserView(entry) };
    },
    async projects() {
      const [projects, ops] = await Promise.all([listProjects(home), listOperations(home)]);
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        repo: p.repo,
        base: p.base,
        operations: ops.filter((o) => o.project === p.id).map((o) => ({ id: o.id, name: o.name })),
      }));
    },
    projectConfig,
    async createProject(input) {
      const { defaults } = await readSettings(home);
      const detected = await detectRepo(input.repo, hooks.run ?? createRun());
      const topRepo = detected.fields.integration;

      // One repo is one project: re-creating for a repo that already has a project reuses it.
      const realRepo = await realpath(topRepo).catch(() => topRepo);
      for (const existing of await listProjects(home)) {
        const realExisting = await realpath(existing.repo).catch(() => existing.repo);
        if (realExisting === realRepo) return { id: existing.id };
      }
      const from = input.name?.trim() || detected.fields.name || (topRepo.split("/").filter(Boolean).pop() ?? "project");
      const slug = from.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "") || "project";
      const id = input.id || slug;
      const base = input.base ?? detected.fields.base;
      const integration = input.integration || topRepo;
      // Unchecked on purpose: validateProject rejects a value outside its list, a stale settings default included.
      const tracker = input.tracker ?? detected.fields.tracker ?? defaults.tracker;
      const fleet = input.fleet ?? detected.fields.fleet ?? defaults.fleet;
      const frontend = input.frontend ?? detected.fields.frontend ?? defaults.frontend;
      const delivery = input.delivery ?? detected.fields.delivery ?? defaults.delivery;
      const pause = input.pause ?? defaults.pause;
      const worktreeRoot = input.worktreeRoot ?? detected.fields.worktreeRoot;

      const project = asInput(() => validateProject({
        v: 1,
        id,
        name: input.name?.trim() || from || id,
        repo: topRepo,
        base,
        integration,
        pause,
        tracker,
        fleet,
        frontend,
        delivery,
        createdAt: new Date(now()).toISOString(),
        ...(worktreeRoot ? { worktreeRoot } : {}),
      }));
      await createProject(home, project);
      reposCache = null;
      return { id };
    },
    async setProjectField(id, field, value) {
      if (!(PROJECT_FIELDS as readonly string[]).includes(field)) throw new HttpError(400, `Unknown field "${field}"`);
      await existingProject(id, 404);
      // Project paths are absolute on the wire; resolve("/") is a pass-through for them.
      await mutateProject(home, id, (p) => applyProjectField(p, field, value, "/"));
      workspaceCache.clear();
      return projectConfig(id);
    },
    async installGraphService(id) {
      const project = await existingProject(id, 404);
      const run = hooks.run ?? createRun();
      const dolt = await run("which", ["dolt"], project.repo);
      const doltPath = dolt.stdout.trim();
      if (dolt.code !== 0 || !doltPath.startsWith("/"))
        throw new HttpError(400, "dolt is not on PATH; install it before managing the graph server");
      const result = await installDolt(project.id, project.name, project.repo, { run, doltPath });
      if (result.warnings.length) throw new HttpError(502, result.warnings.join("; "));
      return projectConfig(id);
    },
    async restartGraphService(id) {
      const project = await existingProject(id, 404);
      await restartDolt(project.id, project.repo, { run: hooks.run ?? createRun() });
      return projectConfig(id);
    },
    async deleteProject(id) {
      await existingProject(id, 404);
      const using = await operationsUsingProject(home, id);
      if (using.length) throw new HttpError(409, `Project ${id} has open operations (${using.join(", ")})`);
      await removeProjectDir(home, id);
      reposCache = null;
    },
    async notes(opId) {
      await knownOperation(opId);
      return readNotes(home, opId);
    },
    async setNotes(opId, text, base) {
      await knownOperation(opId);
      try {
        return await writeNotes(home, opId, text, base);
      } catch (error) {
        if (error instanceof StaleRevisionError) throw new HttpError(409, "stale: the notes changed since you loaded them");
        throw error;
      }
    },
    async createDraft(input) {
      const ports = hooks.drafts;
      if (!ports) throw new HttpError(404, "Drafts are unavailable without a frontend runtime");
      const text = input.text;
      if (Buffer.byteLength(text) > MAX_DRAFT_INPUT) throw new HttpError(400, "Draft text exceeds 64 KiB");
      const project = input.project !== undefined && input.project !== "" ? await existingProject(input.project, 400) : null;
      const repo = input.repo ?? project?.repo;
      if (!repo) throw new HttpError(400, "A draft needs a project or a repo to open in");
      if (!isAbsolute(repo)) throw new HttpError(400, "repo must be an absolute path");
      const settings = await readSettings(home);
      const kind = project?.frontend ?? settings.defaults.frontend;
      if (kind === "none")
        throw new HttpError(409, "A draft needs a terminal frontend (set one on the project or in settings)");
      const cap = settings.cap;
      const open = hooks.extras?.("")?.load?.open ?? 0;
      if (open >= cap) throw new HttpError(409, `The board is at its cap (${open}/${cap} live)`);
      const frontend = await ports.frontend(kind, project?.worktreeRoot);
      const id = newDraftId();
      const tracker = project?.tracker ?? settings.defaults.tracker;
      await createDraftDir(home, id, {
        text,
        repo,
        frontend: kind,
        tracker,
        ...(project?.worktreeRoot !== undefined ? { worktreeRoot: project.worktreeRoot } : {}),
        createdAt: new Date(now()).toISOString(),
      });
      try {
        await frontend.ensureRepo(repo);
        const selectedModel = input.model !== undefined
          ? input.model
          : (settings.ai.draft ?? settings.ai.model);
        const argv = ["omp"];
        if (selectedModel) argv.push("--model", selectedModel);
        if (settings.ai.thinking) argv.push("--thinking", settings.ai.thinking);
        // Pin the transcript dir inside the draft dir so closeDraft can ledger its spend.
        const sessionsDir = join(draftDir(home, id), "sessions");
        await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
        argv.push("--session-dir", sessionsDir);
        argv.push(draftPrompt(home, id));
        const terminal = await frontend.openTerminal({
          worktree: repo,
          title: `draft ${id}`,
          argv,
          env: { OMP_HOLOTABLE_CHILD: "1" },
        });
        await recordDraftTerminal(home, id, terminal);
      } catch (error) {
        await removeDraft(home, id).catch(() => undefined);
        throw error;
      }
      return { id };
    },
    async draft(id) {
      const entry = await draftEntry(home, id);
      if (!entry) return { id, state: "missing", createdAt: "" };
      return entry;
    },
    async closeDraft(id) {
      if (!isDraftId(id)) throw new HttpError(400, `Invalid draft id "${id}"`);
      const doc = await readDraftDoc(home, id);
      if (doc?.terminal && hooks.drafts) {
        const frontend = await hooks.drafts.frontend(doc.frontend, doc.worktreeRoot).catch(() => null);
        await frontend?.close(doc.terminal, doc.repo).catch(() => undefined);
      }
      await recordDraftUsage(home, id, new Date(now()).toISOString());
      await removeDraft(home, id);
    },
    async listDrafts() {
      return listDrafts(home);
    },
    async setup() {
      const n = now();
      if (setupCache && n - setupCache.timestamp < 30000) return setupCache.result;
      const result = await runSetupChecks(home, hooks.run);
      setupCache = { timestamp: n, result };
      return result;
    },
    async repos() {
      const n = now();
      if (reposCache && n - reposCache.timestamp < 30000) return reposCache.result;
      const run = hooks.run ?? createRun();
      const [projectsList, recent] = await Promise.all([listProjects(home), readRecentRepos(home)]);
      const rows = await listRepoRows(run, projectsList, recent);
      reposCache = { timestamp: n, result: rows };
      return rows;
    },
    async detect(repo) {
      const detected = await detectRepo(repo, hooks.run ?? createRun());
      const { defaults } = await readSettings(home);
      return {
        fields: { ...detected.fields, pause: defaults.pause },
        reasons: {
          ...detected.reasons,
          pause: defaults.pause ? "Settings mission mode: pause" : "Settings mission mode: auto",
        },
      };
    },
    ...(hooks.usage
      ? {
          usage: async (opId: string | null) => {
            if (opId !== null) await knownOperation(opId);
            return hooks.usage!(opId);
          },
        }
      : {}),
    ...(hooks.plan ? { plan: hooks.plan } : {}),
    ...(hooks.refresh ? { refresh: hooks.refresh } : {}),
    ...(hooks.action ? { action: hooks.action } : {}),
    ...(hooks.settle ? { settle: hooks.settle } : {}),
    ...(hooks.end
      ? {
          end: {
            preview: async (opId: string) => {
              await knownOperation(opId);
              return hooks.end!.preview(opId);
            },
            // Confirm is checked inside before the id is read: a wrong confirm is a 400 even for unknown ids.
            abort: (opId: string, confirm: string) => hooks.end!.abort(opId, confirm),
            close: async (opId: string, outcome: ClosedOutcome) => {
              await knownOperation(opId);
              return hooks.end!.close(opId, outcome);
            },
          },
        }
      : {}),
    models: (refresh, includeUsage) => modelCatalog.getModels(refresh, includeUsage),
  };
}
