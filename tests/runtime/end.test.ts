import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PortError, type Ports, type Run } from "../../src/ports.ts";
import { abortPreview, createEnder, endOperation } from "../../src/runtime/end.ts";
import { windDown, type WinddownDeps } from "../../src/runtime/winddown.ts";
import { ActionError } from "../../src/runtime/errors.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { archiveDir } from "../../src/paths.ts";
import { listArchive, readArchive } from "../../src/store/archive.ts";
import { appendEvent, readEvents } from "../../src/store/events.ts";
import { archiveOperation, listOperations } from "../../src/store/operations.ts";
import { contact, fakePorts, lane, removeAll, seedOperation, tempDir, T0 } from "../helpers.ts";
import { status } from "../helpers.ts";
import { createWatcher } from "../../src/runtime/watcher.ts";
import { makeMeasurements, makeUsageEvidence } from "../core/fixtures.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

const at = () => new Date("2026-01-02T03:04:05Z");

function windDeps(home: string, ports: Ports, run: Run = gitStatus(new Map())): WinddownDeps {
  return { home, now: at, settings: async () => DEFAULT_SETTINGS, portsFor: () => ({ ...ports, run }) };
}

/** A Run that only answers `git status`, from a per-directory porcelain map. Missing dirs are gone. */
function gitStatus(porcelain: Map<string, string>, gone = new Set<string>()): Run {
  return async (command, args, cwd) => {
    if (command === "git" && args.includes("status")) {
      if (gone.has(cwd)) return { stdout: "", stderr: "No such file or directory", code: 128 };
      const text = porcelain.get(cwd) ?? "";
      const stdout = args.includes("-z")
        ? text.split("\n").filter(Boolean).join("\0") + (text.trim() ? "\0" : "")
        : text;
      return { stdout, stderr: "", code: 0 };
    }
    throw new Error(`unexpected spawn: ${command} ${args.join(" ")}`);
  };
}

const kinds = async (home: string, opId = "lab") =>
  (await readEvents(home, opId)).map((e) => `${e.kind}${"contact" in e ? `:${e.contact}` : ""}${e.kind === "operator" && "op" in e ? `(${e.op}${e.ok ? "" : "!"})` : ""}`);

describe("windDown", () => {
  test("closes recorded terminals and removes non-external worktrees, dirty included", async () => {
    const home = tempDir("wd", dirs);
    const wt = join(home, "wt-a");
    mkdirSync(wt, { recursive: true });
    await seedOperation(home, { contacts: [contact("a", { lane: lane(wt, "t1", "b/a") })] });
    const fake = fakePorts();
    await windDown(windDeps(home, fake.ports), "lab", "abort");

    const remove = fake.calls.find((call) => call.method === "removeWorkspace");
    expect(remove?.args).toMatchObject({ force: true });
    expect(fake.count("frontend.close")).toBe(1);
    expect(fake.count("frontend.removeWorkspace")).toBe(1);
    expect(await kinds(home)).toEqual(["queued:a", "launched:a", "reaped:a", "removed:a"]);
  });

  test("removes a dirty worktree on abort too: the operator already saw it dirty", async () => {
    const home = tempDir("wd", dirs);
    const wt = join(home, "wt-a");
    mkdirSync(wt, { recursive: true });
    await seedOperation(home, { contacts: [contact("a", { lane: { worktree: wt, branch: "b/a", frontend: "orca", terminal: null } })] });
    const fake = fakePorts();
    await windDown(windDeps(home, fake.ports), "lab", "abort");
    const remove = fake.calls.find((call) => call.method === "removeWorkspace");
    expect(remove?.args).toMatchObject({ force: true });
    expect(fake.count("frontend.removeWorkspace")).toBe(1);
    expect(await kinds(home)).toContain("removed:a");
  });

  test("terminal-missing counts as closed; a removeWorkspace failure is recorded and the wind-down continues", async () => {
    const home = tempDir("wd", dirs);
    const wtA = join(home, "wt-a");
    const wtB = join(home, "wt-b");
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    await seedOperation(home, {
      contacts: [contact("a", { lane: lane(wtA, "t1") }), contact("b", { lane: lane(wtB, "t2") })],
    });
    const fake = fakePorts();
    // Every recorded terminal is already gone → each still counts as reaped.
    fake.world.fail.set("frontend.close", new PortError("terminal-missing", "gone"));
    await windDown(windDeps(home, fake.ports), "lab", "close");
    const got = await kinds(home);
    expect(got).toContain("reaped:a");
    expect(got).toContain("reaped:b");
    expect(got).toContain("removed:a");
    const removals = fake.calls.filter((call) => call.method === "removeWorkspace");
    expect(removals).toHaveLength(2);
    expect(removals.every((call) => (call.args as { force?: boolean }).force === undefined)).toBe(true);

    fake.world.fail.clear();
    fake.world.fail.set("frontend.removeWorkspace", new Error("locked"));
    const home2 = tempDir("wd", dirs);
    await seedOperation(home2, { contacts: [contact("x", { lane: lane(join(home2, "w"), null) })] });
    await windDown(windDeps(home2, fake.ports), "lab", "abort");
    const got2 = await kinds(home2);
    expect(got2).toContain("operator:x(abort!)");
    const failed = (await readEvents(home2, "lab")).find((e) => e.kind === "operator");
    expect(failed?.kind === "operator" && failed.error).toContain("x: locked");
  });

  test("external lanes are never touched; already-removed lanes are skipped", async () => {
    const home = tempDir("wd", dirs);
    await seedOperation(home, {
      contacts: [
        contact("adopted", { lane: { worktree: "/elsewhere", branch: null, frontend: "external", terminal: null } }),
        contact("done", { lane: { worktree: "/wt/done", branch: null, frontend: "orca", terminal: null } }),
      ],
    });
    await appendEvent(home, "lab", { v: 1, at: T0, kind: "removed", contact: "done", worktree: "/wt/done" });
    const fake = fakePorts();
    await windDown(windDeps(home, fake.ports), "lab", "abort");
    expect(fake.count("frontend.removeWorkspace")).toBe(0);
  });
  test("close preserves dirty and ignored Git worktree content; abort removes it forcibly", async () => {
    const home = tempDir("wd-git", dirs);
    const repo = join(home, "repo");
    const wtClose = join(home, "wt-close");
    const wtAbort = join(home, "wt-abort");
    mkdirSync(repo, { recursive: true });
    const git = (args: string[], cwd = repo) => {
      const result = Bun.spawnSync(["git", ...args], { cwd });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
      return result;
    };
    const run: Run = async (command, args, cwd) => {
      const result = Bun.spawnSync([command, ...args], { cwd });
      return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: result.exitCode ?? 1 };
    };

    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "test@example.invalid"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repo, "tracked.txt"), "committed\n");
    git(["add", "."]);
    git(["commit", "-qm", "initial"]);
    git(["worktree", "add", "-qb", "close-branch", wtClose]);
    git(["worktree", "add", "-qb", "abort-branch", wtAbort]);

    const dirty = (worktree: string) => {
      writeFileSync(join(worktree, "tracked.txt"), "uncommitted\n");
      writeFileSync(join(worktree, "ignored.txt"), "user data\n");
    };
    dirty(wtClose);
    dirty(wtAbort);
    const ports = fakePorts(run).ports;
    ports.frontend.removeWorkspace = async ({ worktree, force }) => {
      const args = ["worktree", "remove", ...(force ? ["--force"] : []), worktree];
      const result = Bun.spawnSync(["git", ...args], { cwd: repo });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
    };

    const closeOp = await seedOperation(home, { id: "close-proof", contacts: [contact("close", { lane: { worktree: wtClose, branch: "close-branch", frontend: "orca", terminal: null } })] });
    await windDown(windDeps(home, ports, run), closeOp.id, "close");
    expect(readFileSync(join(wtClose, "tracked.txt"), "utf8")).toBe("uncommitted\n");
    expect(readFileSync(join(wtClose, "ignored.txt"), "utf8")).toBe("user data\n");

    const abortOp = await seedOperation(home, { id: "abort-proof", contacts: [contact("abort", { lane: { worktree: wtAbort, branch: "abort-branch", frontend: "orca", terminal: null } })] });
    await windDown(windDeps(home, ports, run), abortOp.id, "abort");
    expect(() => readdirSync(wtAbort)).toThrow();
  });
});


describe("abortPreview", () => {
  test("lists terminals, worktrees with the dirty flag, and counts", async () => {
    const home = tempDir("pv", dirs);
    const wtA = join(home, "wt-a");
    const wtB = join(home, "wt-b");
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    await seedOperation(home, {
      contacts: [
        contact("a", { lane: lane(wtA, "t1") }),
        contact("b", { lane: lane(wtB, null) }),
        contact("gone", { lane: lane(join(home, "vanished"), null) }),
        contact("ext", { lane: { worktree: wtA, branch: null, frontend: "external", terminal: null } }),
        contact("q"),
      ],
    });
    await appendEvent(home, "lab", { v: 1, at: T0, kind: "landed", contact: "ext", via: "manual" });
    const fake = fakePorts();
    const gone = join(home, "vanished");
    const run = gitStatus(new Map([[wtB, " M src/app.ts\n"]]), new Set([gone]));
    const deps = { ...windDeps(home, fake.ports, run), run };
    const preview = await abortPreview(deps, "lab");

    expect(preview.terminals).toEqual(["a"]);
    expect(preview.live).toBe(1);
    expect(preview.queued).toBe(1);
    expect(preview.landed).toBe(1);
    // A gone path and an external lane stay out; b reports dirty.
    expect(preview.worktrees).toEqual([
      { ticket: "a", path: wtA, dirty: false, state: "clean", detail: "clean" },
      { ticket: "b", path: wtB, dirty: true, state: "dirty", detail: "1 tracked ( M src/app.ts…)" },
    ]);
  });
});

describe("endOperation / ender", () => {
  test("close refuses `landed` while any contact is unlanded, writes nothing", async () => {
    const home = tempDir("end", dirs);
    await seedOperation(home, { contacts: [contact("a")] });
    const fake = fakePorts();
    await expect(endOperation(windDeps(home, fake.ports), "lab", "landed")).rejects.toThrow("1 contacts have not landed");
    expect(await listOperations(home)).toHaveLength(1);
    expect((await readEvents(home, "lab")).some((e) => e.kind === "closed")).toBe(false);
  });

  test("abort: wrong confirm is a 400 before anything runs", async () => {
    const home = tempDir("end", dirs);
    await seedOperation(home, { contacts: [contact("a")] });
    const fake = fakePorts();
    const ender = createEnder(windDeps(home, fake.ports));
    const error = await ender.abort("lab", "nope").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).status).toBe(400);
    expect((error as ActionError).message).toBe("confirm must be the operation id");
    expect(await listOperations(home)).toHaveLength(1);
  });

  test("abort archives, writes closed abandoned and the report, and frees the operation", async () => {
    const home = tempDir("end", dirs);
    const wt = join(home, "wt-a");
    mkdirSync(wt, { recursive: true });
    await seedOperation(home, { name: "Lab", contacts: [contact("a", { lane: lane(wt, "t1") }), contact("q")] });
    const fake = fakePorts();
    const ender = createEnder(windDeps(home, fake.ports));

    const { archived } = await ender.abort("lab", "lab");
    expect(archived).toMatch(/^lab-\d{14}$/);
    expect(await listOperations(home)).toEqual([]);

    const entry = await readArchive(home, archived, new Date());
    expect(entry).not.toBeNull();
    const eventKinds = entry!.events.map((e) => e.kind);
    expect(eventKinds).toContain("reaped");
    expect(eventKinds).toContain("removed");
    expect(eventKinds.at(-1)).toBe("closed");
    const closed = entry!.events.find((e) => e.kind === "closed");
    expect(closed?.kind === "closed" && closed.outcome).toBe("abandoned");

    expect(entry!.report.outcome).toBe("abandoned");
    expect(entry!.report.counts).toMatchObject({ contacts: 2, landed: 0, launches: 1 });
    expect(entry!.report.contacts.find((c) => c.ticket === "a")?.final).toBe("aborted");
    expect(entry!.report.contacts.find((c) => c.ticket === "q")?.final).toBe("not-launched");
    // report.json is a real file inside the archive.
    const onDisk = JSON.parse(readFileSync(join(archiveDir(home), archived, "report.json"), "utf8"));
    expect(onDisk.v).toBe(1);
    expect(readdirSync(archiveDir(home))).toEqual([archived]);
  });

  test("a second abort while one runs is a 409", async () => {
    const home = tempDir("end", dirs);
    const wt = join(home, "wt-a");
    mkdirSync(wt, { recursive: true });
    await seedOperation(home, { contacts: [contact("a", { lane: lane(wt, "t1") })] });
    const fake = fakePorts();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const ports: Ports = { ...fake.ports, frontend: { ...fake.ports.frontend, close: async () => hold } };
    const ender = createEnder(windDeps(home, ports));

    const first = ender.abort("lab", "lab");
    const second = await ender.abort("lab", "lab").catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ActionError);
    expect((second as ActionError).status).toBe(409);
    release();
    await first;
    expect(await listOperations(home)).toEqual([]);
  });

  test("auto mode is switched off and recorded before the wind-down", async () => {
    const home = tempDir("end", dirs);
    await seedOperation(home, { auto: { enabled: true, launch: true, land: true, maxLive: 2, plans: false, decide: false }, contacts: [contact("a")] });
    const fake = fakePorts();
    const ender = createEnder(windDeps(home, fake.ports));
    await ender.abort("lab", "lab");
    const entry = await readArchive(home, (await listArchive(home, new Date()))[0].key, new Date());
    const auto = entry!.events.find((e) => e.kind === "auto");
    expect(auto?.kind === "auto" && auto.enabled).toBe(false);
  });

  test("close landed after everything landed; the report survives in the archive", async () => {
    const home = tempDir("end", dirs);
    const wt = join(home, "wt-a");
    mkdirSync(wt, { recursive: true });
    await seedOperation(home, { contacts: [contact("a", { lane: lane(wt, "t1") })] });
    await appendEvent(home, "lab", { v: 1, at: T0, kind: "landed", contact: "a", via: "merge" });
    const fake = fakePorts();
    const ender = createEnder(windDeps(home, fake.ports));
    const { archived } = await ender.close("lab", "landed");
    const entry = await readArchive(home, archived, new Date());
    expect(entry!.report.outcome).toBe("landed");
    expect(entry!.report.counts.landed).toBe(1);
    expect(entry!.report.contacts[0].final).toBe("landed");
  });

  test("an archive without report.json gets one built on read, not written back", async () => {
    const home = tempDir("end", dirs);
    await seedOperation(home, { contacts: [contact("a")] });
    // Simulate an old archive: the close path minus report.json.
    await appendEvent(home, "lab", { v: 1, at: T0, kind: "closed", outcome: "failed" });
    const key = await archiveOperation(home, "lab", new Date("2026-01-03T00:00:00Z"));
    const list = await listArchive(home, new Date());
    expect(list).toHaveLength(1);
    expect(list[0].report.outcome).toBe("failed");
    expect(readdirSync(join(archiveDir(home), key))).not.toContain("report.json");
  });
});

test.each(["failed","abandoned"] as const)("ending %s freezes final evidence before producer files disappear",async(outcome)=>{
 const home=tempDir("end-evidence",dirs),wt=join(home,"wt");mkdirSync(wt,{recursive:true});
 await seedOperation(home,{contacts:[contact("a",{lane:lane(wt,"terminal","branch")})]});
 const fake=fakePorts();
 fake.world.statuses.set(wt,status({measurements:makeMeasurements({recordedFailed:2}),usageEvidence:makeUsageEvidence(12)}));
 const close=fake.ports.frontend.close;
 fake.ports.frontend.close=async(...args)=>{fake.world.statuses.delete(wt);await close(...args);};
 const deps=windDeps(home,fake.ports),watcher=createWatcher({...deps,warn:()=>{}});
 const key=await endOperation({...deps,captureMetrics:watcher.capture},"lab",outcome);
 expect(fake.world.statuses.has(wt)).toBe(false);
 const entry=await readArchive(home,key,new Date("2099-01-01"));
 expect(entry?.report.evaluation?.quality?.recordedFailed).toBe(2);
 expect(entry?.report.evaluation?.usage.tokens?.input).toBe(12);
 const sample=entry!.events.findIndex(e=>e.kind==="sample"),reaped=entry!.events.findIndex(e=>e.kind==="reaped");
 expect(sample).toBeLessThan(reaped);expect(sample).toBeGreaterThanOrEqual(0);
 const calls=fake.calls.length;
 expect((await readArchive(home,key,new Date("2100-01-01")))?.report.evaluation).toEqual(entry!.report.evaluation);
 expect(fake.calls.length).toBe(calls);
});

test("crashed close recovery archives persisted evidence without touching any producer",async()=>{
 const home=tempDir("end-evidence",dirs);await seedOperation(home,{contacts:[contact("a",{lane:lane("/gone","terminal","branch")})]});
 await appendEvent(home,"lab",{v:1,at:T0,kind:"sample",contact:"a",mission:{id:"run",hold:"none",verify:"failed",complete:false},measurements:makeMeasurements({recordedFailed:1})});
 await appendEvent(home,"lab",{v:1,at:T0,kind:"closed",outcome:"failed"});
 const fake=fakePorts(),key=await endOperation({...windDeps(home,fake.ports),captureMetrics:async()=>{throw Error("must not read producer");}},"lab","failed");
 expect(fake.calls).toEqual([]);
 expect((await readArchive(home,key,new Date()))?.report.evaluation?.quality?.recordedFailed).toBe(1);
});

test("malformed optional archived evaluation is omitted without recomputing or rewriting its base report",async()=>{
 const home=tempDir("end-evidence",dirs);await seedOperation(home,{contacts:[]});
 const key=await endOperation(windDeps(home,fakePorts().ports),"lab","failed"),file=join(archiveDir(home),key,"report.json");
 const stored=JSON.parse(readFileSync(file,"utf8"));
 stored.counts.contacts=47;stored.evaluation.usage.basis={toString:null};
 const bytes=JSON.stringify(stored);writeFileSync(file,bytes);
 const loaded=await readArchive(home,key,new Date("2099-01-01"));
 expect(loaded?.report.evaluation).toBeUndefined();expect(loaded?.report.counts.contacts).toBe(47);
 expect(readFileSync(file,"utf8")).toBe(bytes);
});
