import { access, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { lock } from "proper-lockfile";
import type { Project, StoredOperation } from "../core/types.ts";
import { OVERRIDABLE_FIELDS } from "../core/types.ts";
import { validateOperationDoc } from "../core/validate-operation.ts";
import { validateProject } from "../core/validate-project.ts";
import { operationDir, operationsDir } from "../paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { readOperationDoc } from "./operations.ts";
import { createProject, listProjects } from "./projects.ts";

const MARKER = ".v5-projects";
const LOCK_OPTS = { realpath: false, stale: 10_000, retries: { retries: 5, minTimeout: 50 } } as const;
const pending = new Map<string, Promise<void>>();

/**
 * One-time migration: open operations without `project` are grouped by repo
 * realpath; each group gets a project seeded from its oldest operation (or
 * reuses an existing project for that repo), and each operation keeps only
 * the fields that differ. Idempotent via the marker file; guarded per-process
 * and by a lock on the marker path across processes.
 */
export async function migrateHome(home: string): Promise<void> {
  const marker = join(home, MARKER);
  try {
    await access(marker);
    return;
  } catch {
    // Marker absent: run (or wait for the in-flight run for this home).
  }
  const inFlight = pending.get(home);
  if (inFlight) return inFlight;
  const run = runMigration(home, marker).finally(() => pending.delete(home));
  pending.set(home, run);
  return run;
}

async function runMigration(home: string, marker: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const release = await lock(marker, { realpath: false, stale: 10_000, retries: { retries: 10, minTimeout: 50 } });
  try {
    try {
      await access(marker);
      return;
    } catch {
      // Another process beat us to it, or first run.
    }

    let entries: string[] = [];
    try {
      entries = await readdir(operationsDir(home));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // repo realpath -> stored docs that still need a project. Reading through
    // readOperationDoc first runs each document's workflow → notes.md migration.
    const groups = new Map<string, StoredOperation[]>();
    for (const entry of entries.sort()) {
      let stored: StoredOperation;
      try {
        stored = (await readOperationDoc(home, entry)).stored;
      } catch (error) {
        // Validation failures and missing files skip the document; lock
        // contention and I/O errors abort so the whole run retries later.
        if (isSkippableDocError(error)) continue;
        throw error;
      }
      // Legacy files have no `project` key at all; only an assigned project means done.
      if (
        (stored.project !== null && stored.project !== undefined) ||
        typeof stored.repo !== "string" ||
        typeof stored.base !== "string" ||
        typeof stored.integration !== "string" ||
        stored.tracker === undefined ||
        stored.fleet === undefined ||
        stored.frontend === undefined ||
        stored.delivery === undefined ||
        typeof stored.pause !== "boolean"
      )
        continue;
      const repo = stored.repo;
      const key = await realpath(repo).catch(() => repo);
      const group = groups.get(key) ?? [];
      group.push(stored);
      groups.set(key, group);
    }

    const projects = await listProjects(home);
    const used = new Set(projects.map((p) => p.id));
    const projectByRepo = new Map<string, Project>();
    for (const project of projects) {
      const key = await realpath(project.repo).catch(() => project.repo);
      if (!projectByRepo.has(key)) projectByRepo.set(key, project);
    }

    for (const [repoKey, group] of groups) {
      let project = projectByRepo.get(repoKey);
      if (project === undefined) {
        const oldest = group.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
        const id = uniqueId(slug(basename(oldest.repo ?? "project")), used);
        used.add(id);
        project = validateProject(
          {
            v: 1,
            id,
            name: basename(oldest.repo ?? "") || id,
            repo: oldest.repo,
            base: oldest.base,
            integration: oldest.integration,
            pause: oldest.pause,
            tracker: oldest.tracker,
            fleet: oldest.fleet,
            frontend: oldest.frontend,
            delivery: oldest.delivery,
            createdAt: oldest.createdAt,
            ...(oldest.worktreeRoot !== undefined ? { worktreeRoot: oldest.worktreeRoot } : {}),
          },
          `<${id}>/project.json`,
        );
        await createProject(home, project);
      }

      for (const stored of group) {
        await assignOperation(home, stored.id, project);
      }
    }

    await writeFileAtomic(marker, "1\n");
  } finally {
    await release();
  }
}

/**
 * Point one operation at `project` under its document lock, re-reading the file
 * so a concurrent mutation is never clobbered, and dropping fields it now
 * inherits. A document that vanished, turned invalid, or was already assigned
 * is left alone; lock and I/O errors abort the migration.
 */
async function assignOperation(home: string, id: string, project: Project): Promise<void> {
  const path = join(operationDir(home, id), "operation.json");
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const release = await lock(path, { ...LOCK_OPTS });
  try {
    let stored: StoredOperation;
    try {
      stored = validateOperationDoc(JSON.parse(await readFile(path, "utf8")), path, null).stored;
    } catch (error) {
      if (isSkippableDocError(error)) return;
      throw error;
    }
    // A concurrent attach already assigned a project: leave it alone.
    if (stored.project !== null && stored.project !== undefined) return;
    const next: Record<string, unknown> = { ...stored, project: project.id };
    for (const field of OVERRIDABLE_FIELDS) {
      if (field === "worktreeRoot") {
        if (next.worktreeRoot === project.worktreeRoot) delete next.worktreeRoot;
        continue;
      }
      if (next[field] === project[field]) delete next[field];
    }
    const fixed = validateOperationDoc(next, path, project).stored;
    await writeFileAtomic(path, `${JSON.stringify(fixed, null, 2)}\n`);
  } finally {
    await release();
  }
}

/** True for the per-document failures that skip an operation without aborting the run. */
function isSkippableDocError(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("Invalid ") || message.includes("ENOENT");
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s.length > 0 ? s : "project";
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base.slice(0, 44)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
