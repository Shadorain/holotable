import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHolotableCore } from "../../src/plugin/core.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { startBoard } from "../../src/service.ts";
import { createOperation } from "../../src/store/operations.ts";
import { fakePorts, noRun, operation } from "../helpers.ts";
import { readRecentRepos } from "../../src/store/recent-repos.ts";
import type { Run } from "../../src/ports.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function setup(current: () => string | null = () => null) {
  const home = mkdtempSync(join(tmpdir(), "holotable-core-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const core = createHolotableCore({ home, now: () => new Date("2026-01-02T00:00:00Z"), current });
  return { home, core, run: (args: string) => core.runCommand(args, { cwd: home }) };
}

test("the core runs store commands: new, use, zone, add, list", async () => {
  const { core, run } = setup();
  const created = await run("new lab --repo /tmp/r --base main");
  expect(created.message).toContain("Created lab");
  expect(created.current).toBe("lab");
  // Like the OMP adapter, the caller threads the selection back in.
  const ctx = { cwd: "/tmp", current: created.current ?? null };
  await core.runCommand("zone Ops", ctx);
  const added = await core.runCommand("add CHR-1 --zone ops", ctx);
  expect(added.message).toContain("CHR-1 queued in lab/ops");
  expect((await core.runCommand("list", ctx)).message).toContain("lab");
});

test("stop explains that lifecycle belongs to the service", async () => {
  const { run } = setup();
  expect((await run("stop")).message).toContain("holotable serve");
});

test("completions come from the store, not the host", async () => {
  const { core } = setup();
  await core.runCommand("new lab --repo /tmp/r --base main", { cwd: "/tmp" });
  await core.runCommand("zone Ops", { cwd: "/tmp", current: "lab" });
  const values = (prefix: string, current?: string | null) => core.completions(prefix, current).then((rows) => rows?.map((i) => i.value) ?? null);
  expect(await values("use ")).toEqual(["use lab "]);
  expect(await values("add t --zone ", "lab")).toEqual(["add t --zone ops "]);
});

test("service() and status() describe a stopped then running service", async () => {
  const { home, core } = setup();
  expect(await core.service()).toEqual({ running: false, url: null, pid: null });
  expect(await core.status()).toContain("board not running");
  await createOperation(home, operation());
  const board = await startBoard({
    home,
    settings: { ...DEFAULT_SETTINGS, port: 0, pollMs: 60_000, sampleMs: 60_000 },
    run: noRun,
    portsFor: () => fakePorts().ports,
  });
  cleanup.push(() => board.close());
  const health = await core.service();
  expect(health.running).toBe(true);
  expect(health.url).toBe(board.url);
  expect(health.pid).toBe(process.pid);
  const row = await core.status("lab");
  expect(row).toContain("holotable · Lab");
  expect(row).not.toContain("not running");
});

test("recordRecent writes the session's git top-level into recent-repos.json", async () => {
  const { home, core } = setup();
  const run: Run = async (command, args, cwd) =>
    command === "git" && args[0] === "rev-parse" ? { stdout: `${cwd}\n`, stderr: "", code: 0 } : { stdout: "", stderr: "", code: 1 };
  const coreWithRun = createHolotableCore({ home, now: () => new Date(), run });
  await coreWithRun.recordRecent("/work/myrepo");
  expect(await readRecentRepos(home)).toEqual(["/work/myrepo"]);
  // A non-git cwd records nothing; the default core silently no-ops on failure.
  const notGit = createHolotableCore({
    home,
    now: () => new Date(),
    run: async () => ({ stdout: "", stderr: "fatal", code: 128 }),
  });
  await notGit.recordRecent("/not/a/repo");
  expect(await readRecentRepos(home)).toEqual(["/work/myrepo"]);
});
