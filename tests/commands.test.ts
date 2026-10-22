import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, type CommandEnv } from "../src/commands.ts";
import { archiveDir } from "../src/paths.ts";
import { readEvents } from "../src/store/events.ts";
import { listOperations, readOperation, readOperationDoc } from "../src/store/operations.ts";
import { readProject } from "../src/store/projects.ts";
import { readSettings } from "../src/store/settings.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(current: string | null = null): CommandEnv {
  const home = mkdtempSync(join(tmpdir(), "holotable-cmd-"));
  dirs.push(home);
  return { home, cwd: home, now: new Date("2026-01-02T03:04:05Z"), current };
}
async function withLab(extra = ""): Promise<CommandEnv> {
  const env = fixture();
  const out = await runCommand(`new lab --repo /tmp/r --base main --no-closer ${extra}`, env);
  env.current = out.current ?? null;
  await runCommand("zone Ops", env);
  return env;
}
const kinds = async (env: CommandEnv) => (await readEvents(env.home, "lab")).map((e) => `${e.kind}${"contact" in e ? `:${e.contact}` : ""}`);


test("standalone CLI preserves an empty value when clearing a model preference", async () => {
  const env = fixture();
  await runCommand("config ai.model test/model", env);
  const child = Bun.spawn([
    "bun", fileURLToPath(new URL("../bin/holotable.ts", import.meta.url)),
    "--home", env.home, "config", "ai.model", "",
  ], {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(env.home, "agent"), OMP_HOLOTABLE_HOME: env.home },
    stdout: "ignore", stderr: "inherit", timeout: 10_000,
  });
  expect(await child.exited).toBe(0);
  expect((await readSettings(env.home)).ai.model).toBeNull();
});

test("new creates and selects an operation with settings defaults, ending with a closer", async () => {
  const env = fixture();
  const out = await runCommand("new lab --repo /tmp/r --base main --name Lab", env);
  expect(out.current).toBe("lab");
  const op = await readOperation(env.home, "lab");
  expect(op).toMatchObject({ name: "Lab", repo: "/tmp/r", integration: "/tmp/r", pause: false, tracker: "none", fleet: "omp-mission", frontend: "none", delivery: "none" });
  expect(op.auto).toBeUndefined();
  // defaults.closer is on: a zone-less operation gets a Closer zone to hold it.
  expect(op.zones).toEqual([{ id: "closer", label: "Closer" }]);
  expect(op.contacts.map((c) => [c.ticket, c.kind, c.zone, c.title, c.blockedBy])).toEqual([["CLOSER", "closer", "closer", "Closer review", []]]);
  expect(await kinds(env)).toEqual(["queued:CLOSER"]);
});

test("new --no-closer, or defaults.closer off, creates no closer; --closer overrides the setting", async () => {
  const env = fixture();
  await runCommand("new lab --repo /tmp/r --base main --no-closer", env);
  expect((await readOperation(env.home, "lab")).contacts).toEqual([]);
  await runCommand("config defaults.closer false", env);
  await runCommand("new two --repo /tmp/r --base main", env);
  expect((await readOperation(env.home, "two")).contacts).toEqual([]);
  await runCommand("new three --repo /tmp/r --base main --closer", env);
  expect((await readOperation(env.home, "three")).contacts.map((c) => c.kind)).toEqual(["closer"]);
  await expect(runCommand("new four --repo /tmp/r --base main --closer --no-closer", env)).rejects.toThrow("pass only one of --closer and --no-closer");
});

test("new --from seeds zones, contacts and workflow and queues each contact; the closer comes last, blocked by all", async () => {
  const env = fixture();
  const file = join(env.home, "seed.json");
  writeFileSync(file, JSON.stringify({
    zones: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    workflow: [{ id: "ship", label: "Ship it" }],
    contacts: [{ ticket: "one", zone: "a" }, { ticket: "two", zone: "a", blockedBy: ["one"], title: "Second" }],
  }));
  await runCommand(`new lab --repo /tmp/r --base main --from seed.json`, env);
  const op = await readOperation(env.home, "lab");
  expect(op.zones.map((z) => z.id)).toEqual(["a", "b"]);
  expect(op.contacts.map((c) => [c.ticket, c.kind, c.zone, c.lane])).toEqual([["one", "implement", "a", null], ["two", "implement", "a", null], ["CLOSER", "closer", "b", null]]);
  expect(await kinds(env)).toEqual(["queued:one", "queued:two", "blocked:two", "queued:CLOSER", "blocked:CLOSER"]);
  const events = await readEvents(env.home, "lab");
  expect(events.at(-1)).toMatchObject({ kind: "blocked", contact: "CLOSER", by: ["one", "two"] });
});

test("add closer queues the operation's closer, blocked again by contacts added later; a second is refused", async () => {
  const env = await withLab("--tracker linear");
  await runCommand("add chr-1 --zone ops", env);
  expect((await runCommand("add closer", env)).message).toContain("CLOSER queued in lab as its closer");
  await runCommand("add chr-2 --zone ops", env);
  const op = await readOperation(env.home, "lab");
  expect(op.contacts.map((c) => [c.ticket, c.kind, c.zone])).toEqual([["CHR-1", "implement", "ops"], ["CLOSER", "closer", "ops"], ["CHR-2", "implement", "ops"]]);
  const events = await readEvents(env.home, "lab");
  expect(events.filter((e) => e.kind === "blocked" && e.contact === "CLOSER").map((e) => (e.kind === "blocked" ? e.by : null))).toEqual([["CHR-1"], ["CHR-1", "CHR-2"]]);
  await expect(runCommand("add closer AUDIT-9", env)).rejects.toThrow("only one closer per operation");
  await expect(runCommand("add chr-3 --zone ops --blocked-by CLOSER", env)).rejects.toThrow("must not wait for closer CLOSER");
});

test("new --auto enables operation auto mode with safe defaults", async () => {
  const env = fixture();
  await runCommand("new lab --repo /tmp/r --base main --auto", env);
  const op = await readOperation(env.home, "lab");
  expect(op.auto).toEqual({
    enabled: true,
    launch: true,
    land: true,
    maxLive: 4,
    plans: false,
    decide: false,
  });
  expect(op.pause).toBe(false);
  expect(op.recover).toBe(false);
});

test("new --auto preserves safety boundaries and explicit overrides", async () => {
  const env = fixture();
  await runCommand("new lab --repo /tmp/r --base main --auto --no-pause --recover", env);
  const op = await readOperation(env.home, "lab");
  expect(op.pause).toBe(false);
  expect(op.recover).toBe(true);
  expect(op.auto?.enabled).toBe(true);
  expect(op.auto?.plans).toBe(false);
});

test("pause follows settings, then the project, and explicit flags win", async () => {
  const env = fixture();
  await runCommand("config defaults.pause true", env);
  await runCommand("project new paused --repo /tmp/paused --base main", env);
  expect((await readProject(env.home, "paused")).pause).toBe(true);
  await runCommand("new from-project --project paused", env);
  expect((await readOperation(env.home, "from-project")).pause).toBe(true);
  await runCommand("new forced-off --project paused --no-pause", env);
  expect((await readOperation(env.home, "forced-off")).pause).toBe(false);

  await runCommand("config defaults.pause auto", env);
  expect((await readProject(env.home, "paused")).pause).toBe(true);
  await runCommand("project new open --repo /tmp/open --base main", env);
  expect((await readProject(env.home, "open")).pause).toBe(false);
  await runCommand("new inherited --project open", env);
  expect((await readOperation(env.home, "inherited")).pause).toBe(false);
  await runCommand("new forced-on --project open --pause", env);
  expect((await readOperation(env.home, "forced-on")).pause).toBe(true);
  await runCommand("new standalone --repo /tmp/alone --base main", env);
  expect((await readOperation(env.home, "standalone")).pause).toBe(false);
  await expect(runCommand("new both --repo /tmp/both --base main --pause --no-pause", env)).rejects.toThrow("pass only one of --pause and --no-pause");
});

test("new --auto respects seed auto configuration and precedence", async () => {
  const env = fixture();
  const file = join(env.home, "seed.json");
  writeFileSync(
    file,
    JSON.stringify({
      zones: [{ id: "ops", label: "Ops" }],
      auto: { maxLive: 2, decide: true },
    }),
  );
  await runCommand("new lab --repo /tmp/r --base main --auto --from seed.json", env);
  const op = await readOperation(env.home, "lab");
  expect(op.auto).toEqual({
    enabled: true,
    launch: true,
    land: true,
    maxLive: 2,
    plans: false,
    decide: true,
  });
});

test("new without --auto preserves an explicitly enabled seed configuration", async () => {
  const env = fixture();
  const file = join(env.home, "seed.json");
  writeFileSync(file, JSON.stringify({ auto: {
    enabled: true, launch: false, land: false, maxLive: 3, plans: false, decide: false,
  } }));
  await runCommand("new lab --repo /tmp/r --base main --from seed.json", env);
  expect((await readOperation(env.home, "lab")).auto).toEqual({
    enabled: true, launch: false, land: false, maxLive: 3, plans: false, decide: false,
  });
});

test("new --project with --auto inherits repo/base and sets auto mode", async () => {
  const env = fixture();
  await runCommand("project new lab-proj --repo /tmp/r --base main", env);
  await runCommand("new lab --project lab-proj --auto", env);
  const op = await readOperation(env.home, "lab");
  expect(op.project).toBe("lab-proj");
  expect(op.repo).toBe("/tmp/r");
  expect(op.base).toBe("main");
  expect(op.auto?.enabled).toBe(true);
});

test("new rejects bad input and writes nothing", async () => {
  const env = fixture();
  await expect(runCommand("new lab --repo /tmp/r", env)).rejects.toThrow("Usage: /holotable new");
  await expect(runCommand("new lab --repo /tmp/r --base main --tracker jira", env)).rejects.toThrow("--tracker must be one of");
  await expect(runCommand("new Bad_Id --repo /tmp/r --base main", env)).rejects.toThrow("Invalid operation");
  await expect(runCommand("new lab --repo /tmp/r --base main --from missing.json", env)).rejects.toThrow("Cannot read --from");
  expect(await listOperations(env.home)).toEqual([]);
  await runCommand("new lab --repo /tmp/r --base main", env);
  await expect(runCommand("new lab --repo /tmp/r --base main", env)).rejects.toThrow();
  await expect(runCommand("new lab --repo /tmp/r --base main --auto --bogus", env)).rejects.toThrow("unknown flag --bogus");
});

test("list marks the selected operation and hides archived ones unless --all", async () => {
  const env = await withLab();
  await runCommand("new old --repo /tmp/r --base main", env);
  await runCommand("close old abandoned", env);
  expect((await runCommand("list", env)).message).toBe("* lab  lab");
  expect((await runCommand("list --all", env)).message).toContain("old  old  (archived)");
});

test("use selects an existing operation and rejects an unknown one", async () => {
  const env = await withLab();
  expect((await runCommand("use lab", env)).current).toBe("lab");
  await expect(runCommand("use nope", env)).rejects.toThrow();
  await expect(runCommand("use", env)).rejects.toThrow("Usage: /holotable use");
});

test("zone derives a unique id from its label; needs a selection and a label", async () => {
  const env = await withLab();
  await runCommand('zone "Second zone"', env);
  await runCommand("zone Ops", env);
  expect((await readOperation(env.home, "lab")).zones).toEqual([
    { id: "ops", label: "Ops" },
    { id: "second-zone", label: "Second zone" },
    { id: "ops-2", label: "Ops" },
  ]);
  await expect(runCommand("zone", env)).rejects.toThrow("Usage");
  await expect(runCommand("zone x", { ...env, current: null })).rejects.toThrow("No operation selected");
});

test("set changes one field and refuses a tracker that invalidates tickets", async () => {
  const env = await withLab();
  await runCommand("set pause false", env);
  await runCommand("set frontend herdr", env);
  await runCommand("add notes --zone ops", env);
  expect(await readOperation(env.home, "lab")).toMatchObject({ pause: false, frontend: "herdr" });
  await expect(runCommand("set tracker linear", env)).rejects.toThrow("Invalid operation");
  expect((await readOperation(env.home, "lab")).tracker).toBe("none");
  await expect(runCommand("set pause maybe", env)).rejects.toThrow("pause must be one of");
  await expect(runCommand("set colour red", env)).rejects.toThrow("field must be one of");
});

test("set <field> inherit drops the override and follows the project again", async () => {
  const env = fixture();
  await runCommand("project new lab-proj --repo /tmp/r --base main --frontend herdr", env);
  env.current = (await runCommand("new lab --project lab-proj --no-closer", env)).current ?? null;
  await runCommand("set frontend custom", env);
  expect((await readOperationDoc(env.home, "lab")).stored.frontend).toBe("custom");

  await runCommand("set frontend inherit", env);
  const doc = await readOperationDoc(env.home, "lab");
  expect(doc.stored.frontend).toBeUndefined();
  expect(doc.operation.frontend).toBe("herdr");
  expect(doc.inherited).toContain("frontend");

  await expect(runCommand("set auto inherit", env)).rejects.toThrow("auto mode belongs to the operation");
  await runCommand("new solo --repo /tmp/solo --base main --no-closer", env);
  await expect(runCommand("set frontend inherit", { ...env, current: "solo" })).rejects.toThrow("solo is standalone");
});

test("add queues, normalizes linear tickets and records blockers", async () => {
  const env = await withLab("--tracker linear");
  await runCommand("add chr-1 --zone ops", env);
  await runCommand("add chr-2 --zone ops --blocked-by chr-1 --kind audit --title Later", env);
  const op = await readOperation(env.home, "lab");
  expect(op.contacts.map((c) => [c.ticket, c.kind, c.blockedBy, c.title])).toEqual([
    ["CHR-1", "implement", [], null],
    ["CHR-2", "audit", ["CHR-1"], "Later"],
  ]);
  expect(await kinds(env)).toEqual(["queued:CHR-1", "queued:CHR-2", "blocked:CHR-2"]);
});
test("standalone CLI preserves task paragraphs, quotes and literal backslashes", async () => {
  const env = await withLab();
  const text = 'First paragraph.\n\nVerify "exact" acceptance and preserve literal \\n and \\u0041.';
  const child = Bun.spawn([
    "bun", fileURLToPath(new URL("../bin/holotable.ts", import.meta.url)),
    "--home", env.home, "--current", "lab", "add", "task-1", "--zone", "ops",
    "--title", "Short title", "--description", text,
  ], {
    env: { ...process.env, PI_CODING_AGENT_DIR: join(env.home, "agent"), OMP_HOLOTABLE_HOME: env.home },
    stdout: "ignore", stderr: "inherit", timeout: 10_000,
  });
  expect(await child.exited).toBe(0);
  expect((await readOperation(env.home, "lab")).contacts.find(c => c.ticket === "task-1")?.description).toBe(text);
});


test("add --worktree adopts an existing checkout instead of queueing", async () => {
  const env = await withLab();
  const wt = join(env.home, "wt");
  mkdirSync(wt);
  await runCommand(`add live --zone ops --worktree ${wt}`, env);
  const [contact] = (await readOperation(env.home, "lab")).contacts;
  expect(contact?.lane).toEqual({ worktree: realpathSync(wt), branch: null, frontend: "external", terminal: null });
  expect(await kinds(env)).toEqual(["adopted:live"]);
  await expect(runCommand("add x --zone ops --worktree /nonexistent/path", env)).rejects.toThrow("does not exist");
});

test("add rejects unknown zone, kind and unsafe blockers without queueing", async () => {
  const env = await withLab();
  await expect(runCommand("add a --zone nowhere", env)).rejects.toThrow("Invalid operation");
  await expect(runCommand("add a --zone ops --kind epic", env)).rejects.toThrow("--kind must be one of");
  await expect(runCommand("add a --zone ops --blocked-by a", env)).rejects.toThrow("Invalid operation");
  await expect(runCommand("add a --zone ops --kind conflict", env)).rejects.toThrow("Invalid operation");
  expect(await kinds(env)).toEqual([]);
});

test("close appends closed, archives the directory and clears the selection", async () => {
  const env = await withLab();
  const out = await runCommand("close lab landed", env);
  expect(out.current).toBeNull();
  expect(await listOperations(env.home)).toEqual([]);
  const [archived] = readdirSync(archiveDir(env.home));
  expect(archived).toBe("lab-20260102030405");
  await expect(runCommand("close lab landed", env)).rejects.toThrow();
  await expect(runCommand("close lab done", env)).rejects.toThrow("outcome must be one of");
});

test("config shows, sets and validates settings", async () => {
  const env = fixture();
  expect((await runCommand("config", env)).message).toContain("cap");
  await runCommand("config cap 4", env);
  await runCommand("config defaults.frontend orca", env);
  const shown = (await runCommand("config", env)).message;
  expect(shown).toContain("4");
  expect(shown).toContain("orca");
  await expect(runCommand("config cap 99", env)).rejects.toThrow("Invalid");
  await expect(runCommand("config nonsense 1", env)).rejects.toThrow();
  await expect(runCommand("config cap", env)).rejects.toThrow("Usage: /holotable config");
});

test("unknown subcommand points at help", async () => {
  await expect(runCommand("frobnicate", fixture())).rejects.toThrow('Unknown subcommand "frobnicate"');
  expect((await runCommand("help", fixture())).message).toContain("/holotable new");
});
