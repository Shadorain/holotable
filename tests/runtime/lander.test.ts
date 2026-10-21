import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitWorkspaces } from "../../src/adapters/git-workspaces.ts";
import { localMergeDelivery } from "../../src/adapters/delivery-local-merge.ts";
import type { ContactStatus, DeliveryProbe } from "../../src/core/types.ts";
import type { Run } from "../../src/ports.ts";
import { createActionRunner } from "../../src/runtime/actions.ts";
import { ActionError } from "../../src/runtime/errors.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { readEvents } from "../../src/store/events.ts";
import { readOperation } from "../../src/store/operations.ts";
import { contact, fakePorts, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";
import { createWatcher } from "../../src/runtime/watcher.ts";
import { makeUsageEvidence } from "../core/fixtures.ts";
import { foldEvents } from "../../src/core/fold.ts";
import { evaluateOperation } from "../../src/core/evaluation.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

const run: Run = async (command, args, cwd) => {
  const p = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
};
const git = async (cwd: string, ...args: string[]) => {
  const out = await run("git", args, cwd);
  if (out.code !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
  return out.stdout.trim();
};

async function setup(capture = false, { ticket = "a", tracker }: { ticket?: string; tracker?: "linear" } = {}) {
  const root = tempDir("land", dirs);
  const repo = join(root, "repo");
  await run("git", ["init", "-q", "-b", "main", repo], root);
  writeFileSync(join(repo, "f.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "g.txt"), "g\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  const branch = async (name: string, file: string, content: string) => {
    await git(repo, "checkout", "-qb", name, "main");
    writeFileSync(join(repo, file), content);
    await git(repo, "commit", "-qam", name);
    await git(repo, "checkout", "-q", "main");
  };
  const home = tempDir("home", dirs);
  await seedOperation(home, {
    repo,
    integration: repo,
    frontend: "herdr",
    delivery: "local-merge",
    ...(tracker ? { tracker } : {}),
    contacts: [contact(ticket, { lane: lane(join(root, "wt-a"), "t1", "feat/a") })],
  });
  const fake = fakePorts();
  const conflictWt = `${repo}-holotable-conflict-abc123`;
  const statuses = new Map<string, ContactStatus>([
    [ticket, status({ worktree: join(root, "wt-a"), complete: true, phase: "complete", ctl: null })],
  ]);
  fake.world.statuses.set(join(root, "wt-a"), statuses.get(ticket) as ContactStatus);
  const portsFor = () => ({
    ...fake.ports,
    delivery: localMergeDelivery(run),
    frontend: { ...fake.ports.frontend, createWorkspace: gitWorkspaces(run).createWorkspace },
  });
  const watcher=createWatcher({home,now:()=>new Date("2026-01-01T03:00:00Z"),settings:async()=>DEFAULT_SETTINGS,portsFor,warn:()=>{}});
  const act = createActionRunner({
    home,
    now: () => new Date("2026-01-01T03:00:00Z"),
    settings: async () => ({ ...DEFAULT_SETTINGS, cleanup: false }),
    portsFor,
    extras: () => ({ statuses: Object.fromEntries(statuses), owners: {}, probes: {}, load: { live: 0, open: 0 } }),
    sleep: async () => {},
    token: () => "abc123",
    socketWaitMs: 0,
    run,
    captureMetrics:capture?watcher.capture:undefined,
  });
  const events = async () => (await readEvents(home, "lab")).map((e) => e.kind);
  const refused = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(ActionError);
      return error as ActionError;
    }
    throw new Error("expected refusal");
  };
  return { root, repo, home, fake, statuses, conflictWt, branch, act, events, refused };
}

test("a clean land merges on the integration checkout and records landed", async () => {
  const t = await setup();
  await t.branch("feat/a", "g.txt", "g changed\n");
  await t.act({ op: "lab", contact: "a", action: "land", args: {} });
  expect(readFileSync(join(t.repo, "g.txt"), "utf8")).toBe("g changed\n");
  expect(await git(t.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(await git(t.repo, "status", "--porcelain")).toBe("");
  expect((await t.events()).filter((k) => k !== "queued" && k !== "launched")).toEqual(["land-attempt", "landed", "operator"]);
  const landed = (await readEvents(t.home, "lab")).find((e) => e.kind === "landed");
  expect(landed).toMatchObject({ contact: "a", via: "merge" });
});

test("a conflicting land leaves integration clean and opens one conflict mission with the markers in place", async () => {
  const t = await setup();
  await t.branch("feat/a", "f.txt", "one\ntwo from a\nthree\n");
  writeFileSync(join(t.repo, "f.txt"), "one\ntwo from main\nthree\n");
  await git(t.repo, "commit", "-qam", "main moves");
  const mainHead = await git(t.repo, "rev-parse", "HEAD");
  t.fake.world.statuses.set(t.conflictWt, status({ id: "run-c", worktree: t.conflictWt }));
  t.fake.world.alive.add("/tmp/x.sock");

  await t.act({ op: "lab", contact: "a", action: "land", args: {} });

  expect(await git(t.repo, "status", "--porcelain")).toBe("");
  expect(await git(t.repo, "rev-parse", "HEAD")).toBe(mainHead);
  const op = await readOperation(t.home, "lab");
  expect(op.contacts.map((c) => [c.ticket, c.kind, c.conflictOf])).toEqual([["a", "implement", null], ["a-conflict-1", "conflict", "a"]]);
  expect(op.contacts[0]?.lane?.branch).toBe("feat/a");
  const markers = readFileSync(join(t.conflictWt, "f.txt"), "utf8");
  expect(markers).toContain("<<<<<<<");
  expect(await git(t.repo, "branch", "--list", "holotable/conflict-base-*")).toBe("");
  const events = await readEvents(t.home, "lab");
  expect(events.find((e) => e.kind === "land-attempt")).toMatchObject({ outcome: "conflict", paths: ["f.txt"] });
  expect(events.filter((e) => e.kind === "conflict-opened")).toHaveLength(1);
  expect(events.some((e) => e.kind === "landed")).toBe(false);
  expect(t.fake.calls.find((c) => c.method === "launch")?.args).toMatchObject({ conflictPaths: ["f.txt"] });
  expect(op.contacts[1]?.lane?.terminal).not.toBeNull();

  const again = await t.refused(t.act({ op: "lab", contact: "a", action: "land", args: {} }));
  expect(again.message).toBe("conflict mission a-conflict-1 open");
});

test("a Linear ticket's conflict mission keeps the ticket's case, so it is found and launched", async () => {
  const t = await setup(false, { ticket: "CHR-154", tracker: "linear" });
  await t.branch("feat/a", "f.txt", "one\ntwo from a\nthree\n");
  writeFileSync(join(t.repo, "f.txt"), "one\ntwo from main\nthree\n");
  await git(t.repo, "commit", "-qam", "main moves");
  t.fake.world.statuses.set(t.conflictWt, status({ id: "run-c", worktree: t.conflictWt }));
  t.fake.world.alive.add("/tmp/x.sock");
  await t.act({ op: "lab", contact: "CHR-154", action: "land", args: {} });
  const op = await readOperation(t.home, "lab");
  expect(op.contacts.map((c) => c.ticket)).toEqual(["CHR-154", "CHR-154-CONFLICT-1"]);
  const events = await readEvents(t.home, "lab");
  expect(events.find((e) => e.kind === "conflict-opened")).toMatchObject({ conflictContact: "CHR-154-CONFLICT-1" });
  expect(t.fake.count("fleet.launch")).toBe(1);
});

test("once the conflict mission is complete, Land merges its resolution branch", async () => {
  const t=await setup(true);
  await t.branch("feat/a", "f.txt", "one\ntwo from a\nthree\n");
  writeFileSync(join(t.repo, "f.txt"), "one\ntwo from main\nthree\n");
  await git(t.repo, "commit", "-qam", "main moves");
  t.fake.world.statuses.set(t.conflictWt, status({ id: "run-c", worktree: t.conflictWt }));
  t.fake.world.alive.add("/tmp/x.sock");
  await t.act({ op: "lab", contact: "a", action: "land", args: {} });

  // The conflict mission resolves and commits the merge in its own worktree.
  writeFileSync(join(t.conflictWt, "f.txt"), "one\ntwo resolved\nthree\n");
  await git(t.conflictWt, "add", "f.txt");
  await git(t.conflictWt, "commit", "-qm", "resolve");
  t.statuses.set("a-conflict-1",status({id:"run-c",worktree:t.conflictWt,complete:true,phase:"complete",ctl:null,usageEvidence:makeUsageEvidence(31)}));
  t.fake.world.statuses.set(t.conflictWt, t.statuses.get("a-conflict-1") as ContactStatus);

  await t.act({ op: "lab", contact: "a", action: "land", args: {} });
  expect(readFileSync(join(t.repo, "f.txt"), "utf8")).toBe("one\ntwo resolved\nthree\n");
  expect(await git(t.repo, "status", "--porcelain")).toBe("");
  const events = await readEvents(t.home, "lab");
  expect(events.filter((e) => e.kind === "land-attempt").map((e) => (e.kind === "land-attempt" ? e.outcome : ""))).toEqual(["conflict", "clean"]);
  expect(events.filter((e) => e.kind === "landed").map((e) => ("contact" in e ? e.contact : ""))).toEqual(["a", "a-conflict-1"]);
  const sampled=events.findIndex(e=>e.kind==="sample"&&e.contact==="a-conflict-1"),landed=events.findIndex(e=>e.kind==="landed"&&e.contact==="a-conflict-1");
  expect(sampled).toBeGreaterThanOrEqual(0);expect(sampled).toBeLessThan(landed);
  expect(evaluateOperation(await readOperation(t.home,"lab"),foldEvents(events),Date.parse("2026-01-01T03:00:00Z")).usage.tokens?.input).toBe(31);
  expect(events.filter((e) => e.kind === "conflict-opened")).toHaveLength(1);
});

test("unrelated uncommitted files stay put while the land goes through", async () => {
  const t = await setup();
  await t.branch("feat/a", "g.txt", "g changed\n");
  writeFileSync(join(t.repo, "f.txt"), "uncommitted\n");
  await t.act({ op: "lab", contact: "a", action: "land", args: {} });
  expect(readFileSync(join(t.repo, "f.txt"), "utf8")).toBe("uncommitted\n");
  expect(readFileSync(join(t.repo, "g.txt"), "utf8")).toBe("g changed\n");
  expect((await readEvents(t.home, "lab")).some((e) => e.kind === "landed")).toBe(true);
});

test("a dirty file the merge would overwrite refuses the land before any attempt", async () => {
  const t = await setup();
  await t.branch("feat/a", "g.txt", "g changed\n");
  writeFileSync(join(t.repo, "g.txt"), "uncommitted\n");
  const failure = await t.refused(t.act({ op: "lab", contact: "a", action: "land", args: {} }));
  expect(failure.code).toBe("integration-dirty");
  expect((await t.events()).includes("land-attempt")).toBe(false);
});

test("integration on the wrong branch refuses the land", async () => {
  const t = await setup();
  await t.branch("feat/a", "g.txt", "g changed\n");
  await git(t.repo, "checkout", "-qb", "elsewhere");
  const failure = await t.refused(t.act({ op: "lab", contact: "a", action: "land", args: {} }));
  expect(failure.code).toBe("integration-wrong-branch");
});

test("land is refused for a contact that is not complete", async () => {
  const t = await setup();
  t.statuses.set("a", status({ complete: false, phase: "execute", ctl: null }));
  const failure = await t.refused(t.act({ op: "lab", contact: "a", action: "land", args: {} }));
  expect(failure.status).toBe(409);
});

test("failing checks hold Land; operator-only Land anyway merges past them and is recorded", async () => {
  const t = await setup();
  const asked: Array<boolean | undefined> = [];
  const probes: Record<string, DeliveryProbe> = { a: { url: "u", state: "open", mergeable: "clean", checks: "fail", failing: ["Flaky e2e"] } };
  const act = createActionRunner({
    home: t.home,
    now: () => new Date("2026-01-01T03:00:00Z"),
    settings: async () => ({ ...DEFAULT_SETTINGS, cleanup: false }),
    portsFor: () => ({
      ...t.fake.ports,
      delivery: { ...t.fake.ports.delivery, land: async (i) => { asked.push(i.ignoreChecks); return { outcome: "landed" as const, via: "pr" as const }; } },
    }),
    extras: () => ({ statuses: Object.fromEntries(t.statuses), owners: {}, probes, load: { live: 0, open: 0 } }),
    sleep: async () => {},
    token: () => "abc123",
    socketWaitMs: 0,
    run,
  });
  expect((await t.refused(act({ op: "lab", contact: "a", action: "land", args: {} }))).message).toBe("failing check: Flaky e2e");
  expect((await t.refused(act({ op: "lab", contact: "a", action: "land-anyway", args: {}, by: "auto" }))).status).toBe(403);
  expect(asked).toEqual([]);
  await act({ op: "lab", contact: "a", action: "land-anyway", args: {} });
  expect(asked).toEqual([true]);
  const events = await readEvents(t.home, "lab");
  expect(events.some((e) => e.kind === "landed")).toBe(true);
  expect(events.find((e) => e.kind === "operator" && e.op === "land-anyway")).toMatchObject({ ok: true });
});
