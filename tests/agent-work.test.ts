import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project } from "../src/core/projection.ts";
import { ConflictError } from "../src/core/errors.ts";
import type { Event } from "../src/core/types.ts";
import { agentWork, type AgentWorkInput } from "../src/agent-work.ts";
import { runCommand, type CommandEnv } from "../src/commands.ts";
import { readEvents, readFolded } from "../src/store/events.ts";
import { readOperation } from "../src/store/operations.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(): { home: string; path: string; env: CommandEnv } {
  const root = mkdtempSync(join(tmpdir(), "holotable-agent-work-"));
  roots.push(root);
  const home = join(root, "home");
  const path = join(root, "repo");
  mkdirSync(path);
  execFileSync("git", ["init", "-b", "main"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Holotable Test"], { cwd: path });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: path });
  writeFileSync(join(path, "README"), "fixture\n");
  execFileSync("git", ["add", "README"], { cwd: path });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: path, stdio: "ignore" });
  return { home, path, env: { home, cwd: root, now: new Date("2026-10-01T12:00:00.000Z"), current: null } };
}

const runGit = async (command: string, args: string[], cwd: string) => {
  try {
    return { stdout: execFileSync(command, args, { cwd, encoding: "utf8" }), stderr: "", code: 0 };
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return { stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "", code: e.status ?? 1 };
  }
};

async function setup() {
  const fixture = repo();
  const { env, path } = fixture;
  const created = await runCommand(`new agent --repo ${path} --base main --execution agent --no-closer`, env);
  env.current = created.current ?? null;
  await runCommand("zone ops", env);
  await runCommand("add ALPHA --zone ops --kind implement", env);
  await runCommand("add BETA --zone ops --kind implement --blocked-by ALPHA", env);
  return fixture;
}

const call = (home: string, action: AgentWorkInput["action"], extra: Partial<AgentWorkInput> = {}, coordinator = "session-a", at = "2026-10-01T12:00:00.000Z") =>
  agentWork(home, new Date(at), "agent", { action, coordinator, ...extra }, runGit);

test("agent ownership, dependency gates, durable reports, and verified integration remain distinct", async () => {
  const { home, path, env } = await setup();
  await call(home, "claim");
  await expect(call(home, "report", { ticket: "BETA", worker: "job-beta", state: "assigned", summary: "start" })).rejects.toThrow("blocked by dependencies");
  await runCommand("add gamma --zone ops", env);
  await expect(runCommand("set execution missions", env)).rejects.toThrow("active agent work");

  await call(home, "report", { ticket: "ALPHA", worker: "job-alpha", state: "assigned", summary: "assigned" });
  await call(home, "report", { ticket: "ALPHA", worker: "job-alpha", state: "running", summary: "implementing" });
  // A new API call after the first service/process has ended still sees the same owner and report.
  await expect(call(home, "claim", {}, "session-b")).rejects.toThrow("owned by coordinator session-a");
  const events = await readEvents(home, "agent");
  expect(events.filter((event) => event.kind.startsWith("agent-")).map((event) => event.kind)).toEqual([
    "agent-claim", "agent-report", "agent-report",
  ]);
  const runningOperation = await readOperation(home, "agent");
  const runningFolded = await readFolded(home, "agent");
  const runningView = project({
    operation: runningOperation, project: null, notesText: null, events: runningFolded.events, derived: runningFolded.derived,
    statuses: {}, owners: {}, probes: {}, load: { live: 7, open: 9 }, cap: 8, now: Date.parse("2026-10-01T12:00:00.000Z"),
  });
  expect(runningView.contacts[0]).toMatchObject({ state: "running", group: "live", attention: false, agent: { state: "running", summary: "implementing" } });
  expect(runningView.contacts[1]).toMatchObject({ state: "blocked", hold: null, attention: false });

  await call(home, "report", { ticket: "ALPHA", worker: "job-alpha", state: "complete", summary: "changes ready for coordinator review" });
  const operation = await readOperation(home, "agent");
  const folded = await readFolded(home, "agent");
  const view = project({
    operation, project: null, notesText: null, events: folded.events, derived: folded.derived,
    statuses: {}, owners: {}, probes: {}, load: { live: 7, open: 9 }, cap: 8, now: Date.parse("2026-10-01T12:00:00.000Z"),
  });
  expect(view.operation.coordinator).toBe("session-a");
  expect(view.header.live).toBe(7);
  expect(view.contacts[0]).toMatchObject({
    state: "complete", group: "live", owner: "none", actions: [],
    agent: { coordinator: "session-a", worker: "job-alpha", state: "complete", summary: "changes ready for coordinator review" },
  });

  execFileSync("git", ["checkout", "-b", "unrelated"], { cwd: path, stdio: "ignore" });
  writeFileSync(join(path, "unrelated.txt"), "not integrated\n");
  execFileSync("git", ["add", "unrelated.txt"], { cwd: path });
  execFileSync("git", ["commit", "-m", "unrelated"], { cwd: path, stdio: "ignore" });
  const unrelatedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "main"], { cwd: path, stdio: "ignore" });
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  await expect(call(home, "report", { ticket: "ALPHA", worker: "job-alpha", state: "integrated", summary: "landed" })).rejects.toThrow("verification text");
  await expect(call(home, "report", { ticket: "ALPHA", worker: "job-alpha", state: "integrated", summary: "landed", verification: "verified", commit: "a".repeat(40) })).rejects.toThrow("not a commit");
  await expect(call(home, "report", { ticket: "ALPHA", worker: "job-alpha", state: "integrated", summary: "landed", verification: "verified", commit: unrelatedSha })).rejects.toThrow("not an ancestor");
  await call(home, "report", { ticket: "ALPHA", worker: "job-alpha", state: "integrated", summary: "landed", verification: "verified on main", commit: sha });
  expect((await readEvents(home, "agent")).filter((event): event is Extract<Event, { kind: "agent-report" }> => event.kind === "agent-report").at(-1)?.state).toBe("integrated");
  expect((await readFolded(home, "agent")).derived.contacts.ALPHA?.landed).toBe(true);
  await call(home, "report", { ticket: "BETA", worker: "job-beta", state: "assigned", summary: "Dependency is integrated; begin work" });
  await expect(runCommand("set execution missions", env)).rejects.toThrow("active agent work");
});

test("explicit coordinator release preserves work and prevents prior reports from reviving it", async () => {
  const { home } = await setup();
  await call(home, "claim");
  await call(home, "report", { ticket: "ALPHA", worker: "job-old", state: "assigned", summary: "assigned" });
  await call(home, "report", { ticket: "ALPHA", worker: "job-old", state: "running", summary: "running" });
  await call(home, "release");
  await call(home, "claim", {}, "session-b");
  await expect(call(home, "report", { ticket: "ALPHA", worker: "job-old", state: "running", summary: "late old report" })).rejects.toThrow("cannot report");
  await expect(call(home, "report", { ticket: "ALPHA", worker: "job-old", state: "running", summary: "adopt without reassignment" }, "session-b")).rejects.toThrow("new coordinator must explicitly assign");
  await call(home, "report", { ticket: "ALPHA", worker: "job-new", state: "assigned", summary: "explicitly reassigned" }, "session-b");
  await expect(call(home, "report", { ticket: "ALPHA", worker: "job-old", state: "complete", summary: "stale completion" }, "session-b")).rejects.toBeInstanceOf(ConflictError);
  const report = (await readEvents(home, "agent")).filter((event) => event.kind === "agent-report").at(-1);
  expect(report).toMatchObject({ worker: "job-new", coordinator: "session-b", state: "assigned" });
});

test("coordinator decisions validate choices and land without a mission pane", async () => {
  const { home, env } = await setup();
  await runCommand("add CHOOSE --zone ops --kind decision --option yes --option no", env);
  await call(home, "claim");
  await expect(call(home, "decide", { ticket: "CHOOSE", summary: "unsupported", choice: "maybe" })).rejects.toThrow("choice must be one of");
  await call(home, "decide", { ticket: "CHOOSE", summary: "The evidence supports yes.", choice: "yes" });
  const operation = await readOperation(home, "agent");
  const folded = await readFolded(home, "agent");
  const view = project({
    operation, project: null, notesText: null, events: folded.events, derived: folded.derived,
    statuses: {}, owners: {}, probes: {}, load: { live: 0, open: 0 }, cap: 8, now: Date.parse("2026-10-01T12:00:00.000Z"),
  });
  expect(view.contacts.find((contact) => contact.ticket === "CHOOSE")).toMatchObject({
    state: "landed", decision: { choice: "yes", by: "agent", rationale: "The evidence supports yes." },
  });
  expect(view.contacts.find((contact) => contact.ticket === "CHOOSE")?.actions.map((action) => action.id)).toContain("redecide");
});
