import { readFile, realpath } from "node:fs/promises";
import { zoneIdFor } from "./core/zones.ts";
import { resolve } from "node:path";
import {
  DELIVERIES,
  FLEETS,
  FRONTENDS,
  KINDS,
  TRACKERS,
  type AutoMode,
  type ClosedOutcome,
  type Delivery,
  type Fleet,
  type Frontend,
  type Operation,
  type OverridableField,
  type Project,
  type Settings,
  type Tracker,
} from "./core/types.ts";
import { workflowToMarkdown } from "./core/notes.ts";
import { messageOf } from "./core/errors.ts";
import { parseSeed } from "./core/seed.ts";
import { validateProject } from "./core/validate-project.ts";
import { addContact, queueEvents } from "./contacts.ts";
import type { Ports } from "./ports.ts";
import type { Run } from "./ports.ts";
import { agentDir } from "./paths.ts";
import { resolvePorts } from "./adapters/registry.ts";
import { createRun } from "./run.ts";
import { endOperation } from "./runtime/end.ts";
import { formatSettings, setSettingKey } from "./settings.ts";
import { mutateSettings, readSettings } from "./store/settings.ts";
import { seedBriefFromJson, writeBrief, writeSeed } from "./store/brief.ts";
import { readNotes, writeNotes } from "./store/notes.ts";
import { createProject, listProjects, mutateProject, readProject, removeProjectDir } from "./store/projects.ts";
import {
  createOperation,
  listOperations,
  mutateOperation,
  operationsUsingProject,
  readOperation,
} from "./store/operations.ts";
import { appendEvent } from "./store/events.ts";

export interface CommandEnv {
  home: string;
  cwd: string;
  now: Date;
  current: string | null;
  /** Wind-down deps; tests inject fakes, the CLI and service default to the real adapters. */
  end?: { settings?(): Promise<Settings>; portsFor?(operation: Operation, settings: Settings): Ports; run?: Run };
}
export interface CommandOutcome {
  message: string;
  /** Set when the command changes the selected operation; null clears it. */
  current?: string | null;
}

export const CLOSE_OUTCOMES: ClosedOutcome[] = ["landed", "abandoned", "decision", "failed"];
export const SET_FIELDS = [
  "name",
  "base",
  "integration",
  "pause",
  "tracker",
  "fleet",
  "frontend",
  "delivery",
  "worktreeRoot",
  "ignoreChecks",
  "auto",
  "auto.launch",
  "auto.land",
  "auto.maxLive",
  "auto.plans",
  "auto.decide",
  "auto.repairs",
  "auto.reviews",
  "recover",
] as const;
export type SetField = (typeof SET_FIELDS)[number];

/** Fields `project set` and `POST /api/project-config` accept. */
export const PROJECT_FIELDS = [
  "name",
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
export type ProjectField = (typeof PROJECT_FIELDS)[number];

export const HELP = `/holotable: campaign board over omp-mission missions.
  /holotable                     start the board, print its URL
  /holotable stop                stop the board
  /holotable start               start or reuse the board
  /holotable restart             restart the board without changing missions or data
  /holotable status              report the selected home's board health
  /holotable url                 print the running board URLs
  /holotable new <id> --repo <path> --base <branch> [--project <id>] [--name <text>] [--tracker T] [--fleet F] [--frontend H] [--delivery D] [--pause] [--no-pause] [--auto] [--recover] [--from <file.json>] [--brief <file.md>]
  /holotable list [--all]
  /holotable project <new|list|set|attach|detach|delete> …
  /holotable use <id>
  /holotable zone <label>              (id derived from the label)
  /holotable set <${SET_FIELDS.join("|")}> <value>
  /holotable add <ticket> --zone <id> [--kind K] [--blocked-by A,B] [--title text] [--description text] [--worktree <path>]
  /holotable close <id> <landed|abandoned|decision|failed>
  /holotable config [key value]
Launch, land and approve are board clicks only.`;

export function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/gs;
  for (let m = re.exec(input); m; m = re.exec(input)) {
    if (m[1] !== undefined) {
      out.push(
        m[1]
          .replace(/\\(u[0-9a-fA-F]{4}|[\\"/bfnrt])/g, (_, c) => {
            switch (c) {
              case "n": return "\n";
              case "r": return "\r";
              case "t": return "\t";
              case "b": return "\b";
              case "f": return "\f";
              case '"': return '"';
              case "\\": return "\\";
              case "/": return "/";
              default: return String.fromCharCode(Number.parseInt(c.slice(1), 16));
            }
          })
      );
    } else if (m[2] !== undefined) {
      out.push(m[2].replace(/\\(['\\])/g, "$1"));
    } else {
      out.push(m[3] as string);
    }
  }
  return out;
}

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
  /** Every occurrence of a valued flag, for repeatable flags like --option. */
  all: Map<string, string[]>;
}
function parseArgs(tokens: string[], valued: string[], booleans: string[], usage: string): Parsed {
  const all = new Map<string, string[]>();
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (booleans.includes(name)) flags.set(name, true);
    else if (valued.includes(name)) {
      const value = tokens[++i];
      if (value === undefined) throw new Error(`Usage: ${usage} (--${name} needs a value)`);
      flags.set(name, value);
      all.set(name, [...(all.get(name) ?? []), value]);
    } else throw new Error(`Usage: ${usage} (unknown flag --${name})`);
  }
  return { positional, flags, all };
}
function flag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function oneOf<T extends string>(list: readonly T[], value: string, what: string): T {
  if (!(list as readonly string[]).includes(value))
    throw new Error(`${what} must be one of ${list.join(", ")} (got ${value})`);
  return value as T;
}
function requireCurrent(env: CommandEnv): string {
  if (!env.current) throw new Error("No operation selected. Run /holotable use <id> or /holotable new <id> …");
  return env.current;
}


const DEFAULT_AUTO: AutoMode = {
  enabled: false,
  launch: true,
  land: true,
  maxLive: 4,
  plans: false,
  decide: false,
};


export interface NewOperationSpec {
  id: string;
  /** Attach to this project; `repo`/`base` may be omitted to inherit them. */
  project?: string;
  repo?: string;
  base?: string;
  name?: string;
  integration?: string;
  pause?: boolean;
  tracker?: Tracker;
  fleet?: Fleet;
  frontend?: Frontend;
  delivery?: Delivery;
  /** Seed JSON text: zones, contacts, notes, optional "brief" (becomes brief.md); legacy "workflow" becomes task lines. */
  seed?: string;
  /** Brief markdown; overrides a "brief" key in the seed. */
  brief?: string;
  /** Recovery mode: relaunch dead panes and continue resume holds. Default off. */
  recover?: boolean;
  /** Enable automatic launch/land without opting into plan approval or recovery. */
  auto?: boolean;
}

/** The project the selected operation belongs to; `project set`/`detach` work on it. */
async function currentProject(env: CommandEnv): Promise<string> {
  const op = await readOperation(env.home, requireCurrent(env));
  if (!op.project) throw new Error(`${op.id} is standalone: it has no project. Attach one with /holotable project attach <id> ${op.id}.`);
  return op.project;
}

/** Shared by `/holotable new` and `POST /api/operations`: same defaults, validation and queued events. */
export async function createFromSpec(
  home: string,
  now: Date,
  spec: NewOperationSpec,
): Promise<Operation> {
  const { defaults } = await readSettings(home);
  const project = spec.project !== undefined ? await readProject(home, spec.project) : null;
  const seed = spec.seed !== undefined ? parseSeed(spec.seed, "seed") : {};
  const repo = spec.repo ?? project?.repo;
  const base = spec.base ?? project?.base;
  if (!repo || !base) throw new Error("repo and base are required (or pass a project that supplies them)");
  let auto = seed.auto;
  if (spec.auto !== undefined) {
    if (auto === undefined) auto = { ...DEFAULT_AUTO, enabled: spec.auto };
    else if (typeof auto === "object" && auto !== null && !Array.isArray(auto))
      auto = { ...DEFAULT_AUTO, ...auto, enabled: spec.auto };
  }
  const operation = {
    v: 1,
    id: spec.id,
    name: spec.name ?? (typeof seed.name === "string" && seed.name.length ? seed.name : spec.id),
    repo,
    base,
    integration: spec.integration ?? project?.integration ?? repo,
    pause: spec.pause ?? project?.pause ?? defaults.pause,
    tracker: spec.tracker ?? project?.tracker ?? defaults.tracker,
    fleet: spec.fleet ?? project?.fleet ?? defaults.fleet,
    frontend: spec.frontend ?? project?.frontend ?? defaults.frontend,
    delivery: spec.delivery ?? project?.delivery ?? defaults.delivery,
    zones: seed.zones ?? [],
    contacts: ((seed.contacts ?? []) as unknown[]).map((item) => ({
      title: null,
      description: null,
      kind: "implement",
      blockedBy: [],
      ...(typeof item === "object" && item !== null ? item : {}),
      conflictOf: null,
      lane: null,
    })),
    project: project?.id ?? null,
    ...(auto !== undefined ? { auto } : {}),
    recover: spec.recover === true,
    createdAt: now.toISOString(),
  } satisfies Omit<Operation, "ignoreChecks" | "zones" | "contacts" | "auto"> & { zones: unknown[]; contacts: unknown[]; auto?: unknown };
  // Seed zones, contacts and auto are unchecked JSON, and ignoreChecks is left to inherit or default:
  // createOperation validates the whole document before anything is written.
  const created = await createOperation(home, operation as unknown as Operation);
  if (spec.seed !== undefined) {
    await writeSeed(home, created.id, spec.seed);
    await seedBriefFromJson(home, created.id, spec.seed);
    const lines = [
      ...(typeof seed.notes === "string" ? [seed.notes] : []),
      ...(seed.workflow !== undefined
        ? ["## Checklist", ...workflowToMarkdown((seed.workflow ?? []) as Array<{ id: string; label: string }>, {}).split("\n")]
        : []),
    ];
    if (lines.length) await writeNotes(home, created.id, `${lines.join("\n")}\n`, (await readNotes(home, created.id)).revision);
  }
  if (spec.brief !== undefined) await writeBrief(home, created.id, spec.brief);
  await queueEvents(home, now, created, created.contacts.map((c) => c.ticket), "seed");
  return created;
}

function explicitPause(flags: ReadonlyMap<string, string | true>): boolean | undefined {
  const pause = flags.has("pause");
  const noPause = flags.has("no-pause");
  if (pause && noPause) throw new Error("pass only one of --pause and --no-pause");
  if (pause) return true;
  if (noPause) return false;
  return undefined;
}
async function cmdNew(tokens: string[], env: CommandEnv): Promise<CommandOutcome> {

  const usage =
    "/holotable new <id> --repo <path> --base <branch> [--project <id>] [--name <text>] [--tracker T] [--fleet F] [--frontend H] [--delivery D] [--pause] [--no-pause] [--auto] [--recover] [--from <file.json>] [--brief <file.md>]";
  const parsed = parseArgs(
    tokens,
    ["repo", "base", "project", "name", "tracker", "fleet", "frontend", "delivery", "from", "integration", "brief"],
    ["no-pause", "pause", "auto", "recover"],
    usage,
  );
  const [id] = parsed.positional;
  const repo = flag(parsed, "repo");
  const base = flag(parsed, "base");
  const project = flag(parsed, "project");
  if (!id || parsed.positional.length !== 1 || (!project && (!repo || !base))) throw new Error(`Usage: ${usage}`);
  const from = flag(parsed, "from");
  const briefFilePath = flag(parsed, "brief");
  const brief = briefFilePath ? await readFile(resolve(env.cwd, briefFilePath), "utf8").catch((error: unknown) => {
    throw new Error(`Cannot read --brief ${briefFilePath}: ${messageOf(error)}`);
  }) : undefined;
  const created = await createFromSpec(env.home, env.now, {
    id,
    ...(project ? { project } : {}),
    ...(repo ? { repo: resolve(env.cwd, repo) } : {}),
    ...(base ? { base } : {}),
    name: flag(parsed, "name"),
    ...(flag(parsed, "integration") !== undefined || repo !== undefined
      ? { integration: resolve(env.cwd, flag(parsed, "integration") ?? repo ?? "") }
      : {}),
    ...(explicitPause(parsed.flags) !== undefined ? { pause: explicitPause(parsed.flags) } : {}),
    ...(parsed.flags.has("auto") ? { auto: true } : {}),
    ...(parsed.flags.has("recover") ? { recover: true } : {}),
    ...(flag(parsed, "tracker") ? { tracker: oneOf(TRACKERS, flag(parsed, "tracker")!, "--tracker") } : {}),
    ...(flag(parsed, "fleet") ? { fleet: oneOf(FLEETS, flag(parsed, "fleet")!, "--fleet") } : {}),
    ...(flag(parsed, "frontend") ? { frontend: oneOf(FRONTENDS, flag(parsed, "frontend")!, "--frontend") } : {}),
    ...(flag(parsed, "delivery") ? { delivery: oneOf(DELIVERIES, flag(parsed, "delivery")!, "--delivery") } : {}),
    ...(from ? { seed: await readFile(resolve(env.cwd, from), "utf8").catch((error: unknown) => {
      throw new Error(`Cannot read --from ${from}: ${messageOf(error)}`);
    }) } : {}),
    ...(brief !== undefined ? { brief } : {}),
  });
  return {
    message: `Created ${created.id} (${created.contacts.length} contacts, ${created.zones.length} zones). Selected.`,
    current: created.id,
  };
}

async function cmdProject(tokens: string[], env: CommandEnv): Promise<CommandOutcome> {
  const usage =
    "/holotable project new <id> --repo <path> --base <branch> | project list | project set [<id>:]<field> <value> | project attach <id> [op] | project detach [op] | project delete <id>";
  const [sub, ...rest] = tokens;
  switch (sub) {
    case "new": {
      const u = "/holotable project new <id> --repo <path> --base <branch> [--name <text>] [--tracker T] [--fleet F] [--frontend H] [--delivery D] [--pause] [--no-pause] [--integration <path>] [--worktree-root <path>]";
      const parsed = parseArgs(
        rest,
        ["repo", "base", "name", "tracker", "fleet", "frontend", "delivery", "integration", "worktree-root"],
        ["no-pause", "pause"],
        u,
      );
      const [id] = parsed.positional;
      const repo = flag(parsed, "repo");
      const base = flag(parsed, "base");
      if (!id || parsed.positional.length !== 1 || !repo || !base) throw new Error(`Usage: ${u}`);
      const { defaults } = await readSettings(env.home);
      const project = validateProject({
        v: 1,
        id,
        name: flag(parsed, "name") ?? id,
        repo: resolve(env.cwd, repo),
        base,
        integration: resolve(env.cwd, flag(parsed, "integration") ?? repo),
        pause: explicitPause(parsed.flags) ?? defaults.pause,
        tracker: oneOf(TRACKERS, flag(parsed, "tracker") ?? defaults.tracker, "--tracker"),
        fleet: oneOf(FLEETS, flag(parsed, "fleet") ?? defaults.fleet, "--fleet"),
        frontend: oneOf(FRONTENDS, flag(parsed, "frontend") ?? defaults.frontend, "--frontend"),
        delivery: oneOf(DELIVERIES, flag(parsed, "delivery") ?? defaults.delivery, "--delivery"),
        ...(flag(parsed, "worktree-root") ? { worktreeRoot: flag(parsed, "worktree-root")! } : {}),
        createdAt: env.now.toISOString(),
      });
      return { message: `Project ${(await createProject(env.home, project)).id} created.` };
    }
    case "list": {
      const lines: string[] = [];
      for (const p of await listProjects(env.home))
        lines.push(`${p.id}  ${p.name}  ${p.repo}@${p.base}  ops: ${(await operationsUsingProject(env.home, p.id)).join(", ") || "-"}`);
      const orphans = (await listOperations(env.home)).filter((o) => o.project === null).map((o) => o.id);
      return { message: `${lines.join("\n")}\nstandalone: ${orphans.join(", ") || "-"}` };
    }
    case "set": {
      const [field, ...value] = rest;
      const wanted = value.join(" ");
      if (!field || !wanted) throw new Error(`Usage: ${usage}`);
      // `project set` edits the current operation's project; `set <id>:<field>` edits another one.
      const colon = field.indexOf(":");
      const id = colon > 0 ? field.slice(0, colon) : await currentProject(env);
      const key = colon > 0 ? field.slice(colon + 1) : field;
      await mutateProject(env.home, id, (p) => applyProjectField(p, key, wanted, env.cwd));
      return { message: `${id}: ${key} = ${wanted}` };
    }
    case "attach": {
      const [id, maybeOp] = rest;
      if (!id || rest.length > 2) throw new Error(`Usage: ${usage}`);
      const op = maybeOp ?? requireCurrent(env);
      const p = await readProject(env.home, id);
      await mutateOperation(env.home, op, (o) => ({ ...o, project: p.id }));
      return { message: `${op}: attached to ${id}.` };
    }
    case "detach": {
      const [maybeOp] = rest;
      const op = maybeOp ?? requireCurrent(env);
      await mutateOperation(env.home, op, (o) => ({ ...o, project: null }));
      return { message: `${op}: detached.` };
    }
    case "delete": {
      const [id] = rest;
      if (!id || rest.length !== 1) throw new Error(`Usage: ${usage}`);
      const using = await operationsUsingProject(env.home, id);
      if (using.length) throw new Error(`Project ${id} has operations (${using.join(", ")}): detach them first.`);
      await removeProjectDir(env.home, id);
      return { message: `Project ${id} deleted.` };
    }
    default:
      throw new Error(`Usage: ${usage}`);
  }
}

async function cmdList(tokens: string[], env: CommandEnv): Promise<CommandOutcome> {
  const parsed = parseArgs(tokens, [], ["all"], "/holotable list [--all]");
  const rows = await listOperations(env.home, { archived: parsed.flags.has("all") });
  if (!rows.length) return { message: "No operations. Create one with /holotable new <id> --repo <path> --base <branch>." };
  return {
    message: rows
      .map((row) => `${row.id === env.current ? "*" : " "} ${row.id}  ${row.name}${row.archived ? "  (archived)" : ""}`)
      .join("\n"),
  };
}

async function cmdUse(tokens: string[], env: CommandEnv): Promise<CommandOutcome> {
  if (tokens.length !== 1) throw new Error("Usage: /holotable use <id>");
  const op = await readOperation(env.home, tokens[0] as string);
  return { message: `Selected ${op.id}.`, current: op.id };
}

async function cmdZone(tokens: string[], env: CommandEnv): Promise<CommandOutcome> {
  const label = tokens.join(" ").trim();
  if (!label) throw new Error("Usage: /holotable zone <label>");
  const opId = requireCurrent(env);
  let id = "";
  await mutateOperation(env.home, opId, (op) => {
    id = zoneIdFor(label, op.zones.map((z) => z.id));
    return { ...op, zones: [...op.zones, { id, label }] };
  });
  return { message: `Added zone ${label} (${id}) to ${opId}.` };
}

/**
 * One operation field from text, as `/holotable set` and the settings page both write it.
 * `worktreeRoot` "" (or "default") clears the override. With a project, "inherit"
 * copies the project's value in, which the store then drops as an override.
 */
export function applyOperationField(op: Operation, field: string, raw: string, cwd: string, project: Project | null = null): Operation {
  const name = oneOf(SET_FIELDS, field, "field");
  if (raw === "inherit") {
    if (project === null) throw new Error(`${op.id} is standalone: there is no project to inherit ${name} from`);
    if (name.startsWith("auto")) throw new Error(`${name} cannot be inherited: auto mode belongs to the operation`);
    if (name === "recover") throw new Error("recover cannot be inherited: it belongs to the operation");
    if (name === "name") throw new Error("name cannot be inherited: it belongs to the operation");
    const inherited = project[name as OverridableField];
    if (inherited === undefined) {
      const { worktreeRoot: _, ...rest } = op;
      return rest;
    }
    return { ...op, [name]: inherited };
  }
  const value = raw;
  switch (name) {
    case "name":
      return { ...op, name: value };
    case "base":
      return { ...op, base: value };
    case "integration":
      return { ...op, integration: resolve(cwd, value) };
    case "pause":
      return { ...op, pause: oneOf(["true", "false"], value, "pause") === "true" };
    case "ignoreChecks":
      return { ...op, ignoreChecks: oneOf(["true", "false"], value, "ignoreChecks") === "true" };
    case "tracker":
      return { ...op, tracker: oneOf(TRACKERS, value, "tracker") };
    case "fleet":
      return { ...op, fleet: oneOf(FLEETS, value, "fleet") };
    case "frontend":
      return { ...op, frontend: oneOf(FRONTENDS, value, "frontend") };
    case "delivery":
      return { ...op, delivery: oneOf(DELIVERIES, value, "delivery") };
    case "worktreeRoot": {
      const { worktreeRoot: _, ...rest } = op;
      return value === "" || value === "default" ? rest : { ...rest, worktreeRoot: value };
    }
    case "auto": {
      const enabled = oneOf(["on", "off", "true", "false"], value, "auto") === "on" || value === "true";
      const base = op.auto ?? DEFAULT_AUTO;
      return { ...op, auto: { ...base, enabled } };
    }
    case "auto.launch":
    case "auto.land":
    case "auto.plans":
    case "auto.repairs":
    case "auto.reviews":
    case "auto.decide": {
      const flag = oneOf(["on", "off", "true", "false"], value, name);
      const enabled = flag === "on" || flag === "true";
      const base = op.auto ?? DEFAULT_AUTO;
      const patch = name === "auto.launch" ? { launch: enabled } : name === "auto.land" ? { land: enabled } : name === "auto.plans" ? { plans: enabled } : name === "auto.repairs" ? { repairs: enabled } : name === "auto.reviews" ? { reviews: enabled } : { decide: enabled };
      return { ...op, auto: { ...base, ...patch } };
    }
    case "auto.maxLive": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error("auto.maxLive must be an integer from 1 to 64");
      const base = op.auto ?? DEFAULT_AUTO;
      return { ...op, auto: { ...base, maxLive: n } };
    }
    case "recover": {
      const enabled = oneOf(["on", "off", "true", "false"], value, "recover");
      return { ...op, recover: enabled === "on" || enabled === "true" };
    }
    default:
      return op;
  }
}

/**
 * One project field from text, as `/holotable project set` and `POST /api/project-config`
 * both write it. `worktreeRoot` "" (or "default") clears it.
 */
export function applyProjectField(project: Project, field: string, value: string, cwd: string): Project {
  const name = oneOf(PROJECT_FIELDS, field, "field");
  switch (name) {
    case "name":
      return { ...project, name: value };
    case "repo": {
      const repo = resolve(cwd, value);
      const integration = project.integration === project.repo ? repo : project.integration;
      return { ...project, repo, integration };
    }
    case "base":
      return { ...project, base: value };
    case "integration":
      return { ...project, integration: resolve(cwd, value) };
    case "pause":
      return { ...project, pause: oneOf(["true", "false"], value, "pause") === "true" };
    case "ignoreChecks":
      return { ...project, ignoreChecks: oneOf(["true", "false"], value, "ignoreChecks") === "true" };
    case "tracker":
      return { ...project, tracker: oneOf(TRACKERS, value, "tracker") };
    case "fleet":
      return { ...project, fleet: oneOf(FLEETS, value, "fleet") };
    case "frontend":
      return { ...project, frontend: oneOf(FRONTENDS, value, "frontend") };
    case "delivery":
      return { ...project, delivery: oneOf(DELIVERIES, value, "delivery") };
    case "worktreeRoot": {
      const { worktreeRoot: _, ...rest } = project;
      return value === "" || value === "default" ? rest : { ...rest, worktreeRoot: value };
    }
    default:
      return project;
  }
}

/** `set auto|recover` (and the API field writes) is the operator toggling that switch: record it. */
export async function recordConfigToggles(home: string, now: Date, opId: string, before: Operation, after: Operation): Promise<void> {
  const at = now.toISOString();
  if ((before.auto?.enabled ?? false) !== (after.auto?.enabled ?? false))
    await appendEvent(home, opId, { v: 1, at, kind: "auto", enabled: after.auto?.enabled ?? false, by: "operator" });
  if (before.recover !== after.recover)
    await appendEvent(home, opId, { v: 1, at, kind: "recover", enabled: after.recover, by: "operator" });
}

async function cmdSet(tokens: string[], env: CommandEnv): Promise<CommandOutcome> {
  const usage = `/holotable set <${SET_FIELDS.join("|")}> <value>`;
  const [field, ...rest] = tokens;
  const value = rest.join(" ");
  if (!field || !value) throw new Error(`Usage: ${usage}`);
  const name = oneOf(SET_FIELDS, field, "field");
  const opId = requireCurrent(env);
  const before = await readOperation(env.home, opId);
  const next = await mutateOperation(env.home, opId, (op) => applyOperationField(op, name, value, env.cwd));
  await recordConfigToggles(env.home, env.now, opId, before, next);
  return { message: `${opId}: ${name} = ${value}` };
}

async function cmdAdd(tokens: string[], env: CommandEnv): Promise<CommandOutcome> {
  const usage =
    "/holotable add <ticket> --zone <id> [--kind K] [--blocked-by A,B] [--title text] [--description text] [--worktree <path>] [--option X ...] [--recommended X]";
  const parsed = parseArgs(tokens, ["zone", "kind", "blocked-by", "title", "description", "worktree", "option", "recommended"], [], usage);
  const [rawTicket] = parsed.positional;
  const zone = flag(parsed, "zone");
  if (!rawTicket || parsed.positional.length !== 1 || !zone) throw new Error(`Usage: ${usage}`);
  const kind = oneOf(KINDS, flag(parsed, "kind") ?? "implement", "--kind");
  const opId = requireCurrent(env);
  const worktree = flag(parsed, "worktree");
  const real = worktree ? await realpath(resolve(env.cwd, worktree)).catch(() => {
    throw new Error(`--worktree ${worktree} does not exist`);
  }) : null;
  const { ticket, adopted } = await addContact(env.home, env.now, opId, {
    ticket: rawTicket,
    zone,
    kind,
    title: flag(parsed, "title") ?? null,
    description: flag(parsed, "description") ?? null,
    blockedBy: (flag(parsed, "blocked-by") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    ...(parsed.all.has("option") ? { options: parsed.all.get("option")! } : {}),
    ...(flag(parsed, "recommended") !== undefined ? { recommended: flag(parsed, "recommended") } : {}),
    worktree: real,
  });
  return { message: `${ticket} ${adopted ? "adopted" : "queued"} in ${opId}/${zone}.` };
}

async function cmdClose(tokens: string[], env: CommandEnv): Promise<CommandOutcome> {
  const usage = `/holotable close <id> <${CLOSE_OUTCOMES.join("|")}>`;
  if (tokens.length !== 2) throw new Error(`Usage: ${usage}`);
  const [id, rawOutcome] = tokens as [string, string];
  const outcome = oneOf(CLOSE_OUTCOMES, rawOutcome, "outcome");
  // The same path the board's close/abort takes: wind-down, closed event, report, archive.
  const run = env.end?.run ?? createRun();
  const settings = env.end?.settings ?? (() => readSettings(env.home));
  const archived = await endOperation(
    { home: env.home, now: () => env.now, settings, portsFor: env.end?.portsFor ?? ((op, s) => resolvePorts(op, s, run, agentDir())), run },
    id,
    outcome,
  );
  return {
    message: `Closed ${id} (${outcome}). Archived as ${archived}.`,
    ...(env.current === id ? { current: null } : {}),
  };
}

async function cmdConfig(tokens: string[], env: CommandEnv): Promise<CommandOutcome> {
  if (tokens.length === 0) return { message: formatSettings(await readSettings(env.home)) };
  const [key, ...rest] = tokens;
  if (!key || !rest.length) throw new Error("Usage: /holotable config [key value]");
  const next = await mutateSettings(env.home, (current) => setSettingKey(current, key, rest.join(" ")));
  return { message: `Set ${key}.\n${formatSettings(next)}\nChanges to access/port apply when the board restarts.` };
}

export async function runCommand(args: string, env: CommandEnv): Promise<CommandOutcome> {
  const tokens = tokenize(args);
  const [verb, ...rest] = tokens;
  switch (verb) {
    case undefined:
    case "help":
      return { message: HELP };
    case "new":
      return cmdNew(rest, env);
    case "project":
      return cmdProject(rest, env);
    case "list":
      return cmdList(rest, env);
    case "use":
      return cmdUse(rest, env);
    case "zone":
      return cmdZone(rest, env);
    case "set":
      return cmdSet(rest, env);
    case "add":
      return cmdAdd(rest, env);
    case "close":
      return cmdClose(rest, env);
    case "config":
      return cmdConfig(rest, env);
    default:
      throw new Error(`Unknown subcommand "${verb}". Run /holotable help.`);
  }
}
