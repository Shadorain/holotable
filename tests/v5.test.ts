import { afterEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBoardService, HttpError } from "../src/board.ts";
import type { Project } from "../src/core/types.ts";
import { createWatcher } from "../src/runtime/watcher.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { writeSettings } from "../src/store/settings.ts";
import { appendEvent, readEvents } from "../src/store/events.ts";
import { removeDraft } from "../src/store/drafts.ts";
import { migrateHome } from "../src/store/migrate.ts";
import { readNotes, writeNotes } from "../src/store/notes.ts";
import { createOperation, readOperationDoc } from "../src/store/operations.ts";
import { createProject, listProjects } from "../src/store/projects.ts";
import { contact, fakePorts, lane, operation, removeAll, seedOperation, status, tempDir, T0 } from "./helpers.ts";

const bucket: string[] = [];
afterEach(() => removeAll(bucket));

function project(over: Partial<Project> = {}): Project {
  return {
    v: 1,
    id: "lab-proj",
    name: "Lab project",
    repo: "/repo/lab",
    base: "main",
    integration: "/repo/lab-int",
    pause: false,
    tracker: "linear",
    fleet: "omp-mission",
    frontend: "orca",
    delivery: "github-pr",
    createdAt: T0,
    ...over,
  };
}

const home = () => tempDir("v5", bucket);

// ---- B1: projects + one-time grouping migration ----

test("migration groups project-less operations by repo into seeded projects, idempotently", async () => {
  const dir = home();
  await createOperation(dir, operation({ id: "a", name: "A", repo: "/r/one", base: "main", integration: "/r/one" }));
  await createOperation(dir, operation({ id: "b", name: "B", repo: "/r/one", base: "main", integration: "/r/one" }));
  await createOperation(dir, operation({ id: "c", name: "C", repo: "/r/two", base: "dev", integration: "/r/two" }));
  await createOperation(dir, operation({ id: "solo", name: "Solo", repo: "/r/one", base: "main", integration: "/r/one", project: null }));

  await migrateHome(dir);
  const projects = await listProjects(dir);
  const byRepo = new Map(projects.map((p) => [p.repo, p]));
  expect(byRepo.get("/r/one")).toBeDefined();
  expect(byRepo.get("/r/two")?.base).toBe("dev");
  const one = byRepo.get("/r/one")!;
  for (const id of ["a", "b", "solo"]) {
    const doc = await readOperationDoc(dir, id);
    expect(doc.operation.project).toBe(one.id);
  }
  expect((await readOperationDoc(dir, "c")).operation.project).toBe(byRepo.get("/r/two")!.id);

  // Inheritance: a migrated stored doc keeps only the fields that differ.
  const a = await readOperationDoc(dir, "a");
  expect(a.stored.repo).toBeUndefined();
  expect(a.stored.base).toBeUndefined();

  // Idempotent: a second run changes nothing and adds no projects.
  await migrateHome(dir);
  expect((await listProjects(dir)).length).toBe(projects.length);
  expect((await readOperationDoc(dir, "a")).stored).toEqual(a.stored);
});

test("legacy workflow migrates to notes.md task lines on read", async () => {
  const dir = home();
  await createOperation(dir, operation({ id: "old" }));
  const file = join(dir, "operations", "old", "operation.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.workflow = [
    { id: "a", label: "Ship it" },
    { id: "b", label: "Done step" },
  ];
  writeFileSync(file, JSON.stringify(raw));
  // A checklist item's state lives in its latest workflow event.
  await appendEvent(dir, "old", { v: 1, at: T0, kind: "workflow", item: "b", done: true });

  const doc = await readOperationDoc(dir, "old");
  expect((doc.stored as unknown as Record<string, unknown>).workflow).toBeUndefined();
  const notes = await readNotes(dir, "old");
  expect(notes.text).toContain("- [ ] Ship it");
  expect(notes.text).toContain("- [x] Done step");
  // Rewritten on disk too: a second read sees no workflow key.
  expect(JSON.parse(readFileSync(file, "utf8")).workflow).toBeUndefined();
});


test("attach, override, inherit and detach round-trip through stored fields", async () => {
  const dir = home();
  await createProject(dir, project());
  await createOperation(dir, operation({ id: "a", project: null }));
  const svc = createBoardService(dir);

  await svc.setOperationField("a", "project", "lab-proj");
  let doc = await readOperationDoc(dir, "a");
  expect(doc.operation.project).toBe("lab-proj");
  // Full inheritance: the stored doc drops every equal field.
  expect(doc.stored.repo).toBeUndefined();
  expect(doc.stored.tracker).toBeUndefined();
  expect(doc.operation.repo).toBe("/repo/lab");
  expect(doc.operation.tracker).toBe("linear");

  // An override survives on disk.
  await svc.setOperationField("a", "tracker", "github");
  doc = await readOperationDoc(dir, "a");
  expect(doc.stored.tracker).toBe("github");
  expect(doc.operation.tracker).toBe("github");

  // "inherit" clears the override again.
  await svc.setOperationField("a", "tracker", "inherit");
  doc = await readOperationDoc(dir, "a");
  expect(doc.stored.tracker).toBeUndefined();
  expect(doc.operation.tracker).toBe("linear");

  // Detach materializes every field: the operation keeps working without the project.
  await svc.setOperationField("a", "project", "");
  doc = await readOperationDoc(dir, "a");
  expect(doc.operation.project).toBeNull();
  expect(doc.stored.repo).toBe("/repo/lab");
  expect(doc.stored.tracker).toBe("linear");
});

test("project delete is refused while an open operation uses it", async () => {
  const dir = home();
  await createProject(dir, project());
  await createOperation(dir, operation({ id: "a", project: "lab-proj", repo: "/repo/lab", base: "main", integration: "/repo/lab" }));
  const svc = createBoardService(dir);
  await expect(svc.deleteProject("lab-proj")).rejects.toMatchObject({ status: 409 });
  await svc.setOperationField("a", "project", "");
  await svc.deleteProject("lab-proj");
  expect(await listProjects(dir)).toEqual([]);
});

// ---- B2: notes ----

test("notes write with a stale base is a 409; the current revision succeeds", async () => {
  const dir = home();
  await createOperation(dir, operation({ id: "a" }));
  const svc = createBoardService(dir);
  const empty = await svc.notes("a");
  const first = await svc.setNotes("a", "# Notes\n\n- [ ] one\n", empty.revision);
  expect(first.revision).not.toBe("");
  await expect(svc.setNotes("a", "# newer\n", "bogus")).rejects.toMatchObject({ status: 409 });
  const second = await svc.setNotes("a", "# newer\n- [ ] one\n- [x] two\n", first.revision);
  expect(second.revision).not.toBe(first.revision);
  const p = await svc.projection("a");
  expect(p.notes).toEqual({ done: 1, total: 2 });
});

// ---- B5: drafts ----

test("drafts are refused without a frontend runtime", async () => {
  const dir = home();
  await createOperation(dir, operation());
  const svc = createBoardService(dir);
  await expect(svc.createDraft!({ text: "{}", repo: "/tmp/x" })).rejects.toMatchObject({ status: 404 });
});

test("a draft opens a pane, lists leftovers and closes by handle", async () => {
  const dir = home();
  await createOperation(dir, operation());
  const opened: string[] = [];
  const closed: string[] = [];
  const svc = createBoardService(dir, {
    drafts: {
      frontend: async () => ({
        id: "orca",
        ensureRepo: async () => undefined,
        createWorkspace: async () => ({ worktree: "/wt/d", branch: null }),
        openTerminal: async (i) => {
          opened.push(i.title);
          return { handle: "pane-1", incarnationId: "inc-1" };
        },
        listTerminals: async () => null,
        focus: async () => undefined,
        close: async (t) => void closed.push(t.handle),
        removeWorkspace: async () => undefined,
      }),
    },
  });
  // No frontend in settings (the default): refused with the reason, nothing opened.
  await expect(svc.createDraft!({ text: "notes", repo: "/tmp/x" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("terminal frontend") });
  expect(opened).toEqual([]);
  await writeSettings(dir, { ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_SETTINGS.defaults, frontend: "orca" } });
  const { id } = await svc.createDraft!({ text: JSON.stringify({ zones: [] }), repo: "/tmp/x" });
  expect(opened).toEqual([`draft ${id}`]);
  expect(await svc.listDrafts()).toEqual([expect.objectContaining({ id, state: "running" })]);
  await svc.closeDraft(id);
  expect(closed).toEqual(["pane-1"]);
  expect(await svc.listDrafts()).toEqual([]);
});

test("a bad draft id cannot escape the drafts directory", async () => {
  const dir = home();
  await mkdir(join(dir, "drafts", "draft-deadbeef"), { recursive: true });
  writeFileSync(join(dir, "marker.txt"), "keep");
  const svc = createBoardService(dir);
  for (const bad of ["..", ".", "../x", "draft/../x", "notadraft", "draft-zzzzzzzz", "draft-deadbeef/../.."])
    await expect(svc.closeDraft(bad)).rejects.toThrow();
  await expect(removeDraft(dir, "..")).rejects.toThrow();
  await expect(removeDraft(dir, "draft-deadbeef")).resolves.toBeUndefined();
  // The home and its other contents survive: only the real draft dir was removed.
  expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("keep");
});

// ---- watcher: usage sampling ----


test("a status usage field is sampled into the events stats read", async () => {
  const dir = home();
  const fake = fakePorts();
  await seedOperation(dir, {
    contacts: [contact("a", { lane: lane("/wt/a") })],
  });
  const usage = { tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 2 }, costUsd: 0.5, sessions: 1 };
  fake.world.statuses.set("/wt/a", status({ usage }));
  const watcher = createWatcher({
    home: dir,
    now: () => new Date("2026-01-01T00:00:00Z"),
    settings: async () => ({ ...DEFAULT_SETTINGS, sampleMs: 0 }),
    portsFor: () => fake.ports,
    warn: () => undefined,
  });
  await watcher.pass("lab", true);
  const events = await readEvents(dir, "lab");
  const samples = events.filter((e) => e.kind === "sample" && "contact" in e && e.contact === "a");
  expect(samples.length).toBeGreaterThan(0);
  expect(samples.at(-1)).toMatchObject({ usage: { tokens: usage.tokens, costUsd: usage.costUsd } });
});
