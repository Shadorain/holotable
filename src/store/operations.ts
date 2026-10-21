import { access, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { workflowToMarkdown } from "../core/notes.ts";
import type { Operation, OverridableField, Project, StoredOperation } from "../core/types.ts";
import { OVERRIDABLE_FIELDS } from "../core/types.ts";
import { asInput, ConflictError } from "../core/errors.ts";
import { isRecord, MAX_OPERATION_BYTES } from "../core/validate.ts";
import { validateOperationDoc } from "../core/validate-operation.ts";
import { archiveDir, operationDir, operationsDir } from "../paths.ts";
import { readEvents } from "./events.ts";
import { notesExists, readNotes, writeNotes } from "./notes.ts";
import { readProjectOrNull } from "./projects.ts";
import { createFileAtomic, writeFileAtomic } from "./atomic.js";

export { MAX_OPERATION_BYTES };

function operationFile(home: string, id: string): string {
  return join(operationDir(home, id), "operation.json");
}

const LOCK_OPTS = { realpath: false, stale: 10_000, retries: { retries: 5, minTimeout: 50 } } as const;

/** Serialize a stored operation for disk; writes re-validate everything. */
function serializeOperation(operation: StoredOperation): string {
  const serialized = `${JSON.stringify(operation, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_OPERATION_BYTES)
    throw new Error("operation exceeds 1 MiB");
  return serialized;
}

/**
 * Stored form of a resolved operation under `project`: every overridable field
 * whose value equals the project's is dropped (inherited); the rest stay as
 * overrides. With no project the document keeps every field (standalone).
 */
export function storedFromResolved(resolved: Operation, project: Project | null): StoredOperation {
  const stored: StoredOperation = {
    v: 1,
    id: resolved.id,
    name: resolved.name,
    project: resolved.project,
    zones: resolved.zones,
    contacts: resolved.contacts,
    createdAt: resolved.createdAt,
    ...(resolved.auto !== undefined ? { auto: resolved.auto } : {}),
    ...(resolved.recover === true ? { recover: true } : {}),
  };
  const inheriting = project !== null && project.id === resolved.project;
  for (const field of OVERRIDABLE_FIELDS) {
    const value = resolved[field];
    if (inheriting) {
      if (field === "worktreeRoot" ? value === undefined || value === project.worktreeRoot : value === project[field]) continue;
    }
    if (value !== undefined) (stored as Record<OverridableField, unknown>)[field] = value;
  }
  return stored;
}
export interface OperationDoc {
  /** Resolved form: every overridable field present. Runtime and API consume this. */
  operation: Operation;
  /** On-disk form: overridable fields absent where the operation inherits from its project. */
  stored: StoredOperation;
  /** The named project when it still exists, else null (dangling reference). */
  project: Project | null;
  /** Overridable fields currently taken from the project. */
  inherited: OverridableField[];
}

/** The project id a raw document names, or null. */
function projectIdOf(value: unknown): string | null {
  return isRecord(value) && typeof value.project === "string" ? value.project : null;
}

/**
 * Read + validate + resolve an operation, running the one-time workflow →
 * notes.md migration when an old document still carries `workflow`.
 */
export async function readOperationDoc(home: string, id: string): Promise<OperationDoc> {
  const path = operationFile(home, id);
  // Parse without the lock first; only old documents carrying `workflow` need
  // the locked one-time migration below.
  let stored = await readOperationJson(path);
  if (isRecord(stored) && "workflow" in stored)
    stored = await migrateWorkflowKey(home, id, path);
  const project = await readProjectOrNull(home, projectIdOf(stored));
  const doc = validateOperationDoc(stored, path, project);
  return { operation: doc.operation, stored: doc.stored, project, inherited: doc.inherited };
}

async function readOperationJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const wrapped = new Error(`Cannot read operation at ${path}: ${String(error)}`);
    (wrapped as NodeJS.ErrnoException).code = (error as NodeJS.ErrnoException).code;
    throw wrapped;
  }
  if (Buffer.byteLength(text) > MAX_OPERATION_BYTES)
    throw new Error(`Invalid operation at ${path}: file exceeds 1 MiB`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in operation at ${path}: ${String(error)}`);
  }
}

/**
 * Old documents carry `workflow`. Its items become `## Checklist` task lines in
 * notes.md (done state from the latest `workflow` events), the key is dropped,
 * and the file is rewritten. Skipped entirely when notes.md already exists.
 * The caller holds the file lock; returns the document as migrated.
 */
async function migrateWorkflowLocked(home: string, id: string, file: string): Promise<unknown> {
  const current = await readOperationJson(file);
  if (!isRecord(current) || !("workflow" in current)) return current;
  const items = Array.isArray(current.workflow)
    ? (current.workflow as Array<{ id: string; label: string }>)
    : [];
  if (!(await notesExists(home, id))) {
    const done: Record<string, boolean> = {};
    try {
      for (const e of await readEvents(home, id))
        if (e.kind === "workflow") done[e.item] = e.done;
    } catch {
      // An unreadable events file must not block migration: items stay unchecked.
    }
    const { revision } = await readNotes(home, id);
    await writeNotes(home, id, `## Checklist\n${workflowToMarkdown(items, done)}\n`, revision);
  }
  delete current.workflow;
  const fixed = validateOperationDoc(current, file, await readProjectOrNull(home, projectIdOf(current))).stored;
  await writeFileAtomic(file, serializeOperation(fixed));
  return current;
}

/** The one-time `workflow` → notes.md migration under the document's lock. */

/** lock() fails with a raw ENOENT when the directory is missing: report the document. */
async function requireFile(file: string): Promise<void> {
  await access(file).catch((error) => {
    const wrapped = new Error(`Cannot read operation at ${file}: ${String(error)}`);
    (wrapped as NodeJS.ErrnoException).code = (error as NodeJS.ErrnoException).code;
    throw wrapped;
  });
}
async function migrateWorkflowKey(home: string, id: string, file: string): Promise<unknown> {
  await requireFile(file);
  const release = await lock(file, { ...LOCK_OPTS });
  try {
    return await migrateWorkflowLocked(home, id, file);
  } finally {
    await release();
  }
}

export async function readOperation(home: string, id: string): Promise<Operation> {
  return (await readOperationDoc(home, id)).operation;
}

export async function listOperations(
  home: string,
  opts?: { archived?: boolean },
): Promise<Array<{ id: string; name: string; project: string | null; archived: boolean }>> {
  const result: Array<{ id: string; name: string; project: string | null; archived: boolean }> = [];
  const roots: Array<{ dir: string; archived: boolean }> = [
    { dir: operationsDir(home), archived: false },
  ];
  if (opts?.archived) roots.push({ dir: archiveDir(home), archived: true });
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!entry.isDirectory()) continue;
      try {
        // Archived rows read their own resolved file; open rows migrate + resolve.
        if (root.archived) {
          const path = join(root.dir, entry.name, "operation.json");
          const stored = validateOperationDoc(await readOperationJson(path), path, null).stored;
          result.push({ id: stored.id, name: stored.name, project: stored.project, archived: true });
          continue;
        }
        const doc = await readOperationDoc(home, entry.name);
        result.push({ id: doc.stored.id, name: doc.stored.name, project: doc.stored.project, archived: root.archived });
      } catch (error) {
        // A directory without a readable operation.json (stray folder, race with
        // a delete) is not an operation: skip it.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  }
  return result;
}

/** Ids of open operations that still name `projectId`. */
export async function operationsUsingProject(home: string, projectId: string): Promise<string[]> {
  return (await listOperations(home)).filter((row) => row.project === projectId).map((row) => row.id);
}

export async function createOperation(home: string, operation: Operation): Promise<Operation> {
  const target = operationFile(home, operation.id);
  const project = await readProjectOrNull(home, operation.project);
  // The document is the caller's: a rejection is their input, a taken id their conflict.
  const { validated, text } = asInput(() => {
    const stored = storedFromResolved({ ...operation, project: project === null ? null : project.id }, project);
    const validated = validateOperationDoc(stored, target, project);
    return { validated, text: serializeOperation(validated.stored) };
  });
  try {
    await createFileAtomic(target, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ConflictError(`Operation "${operation.id}" already exists`);
    throw new Error(`Cannot create operation at ${target}: ${String(error)}`);
  }
  return validated.operation;
}

/** Mutate operation.json under its lock, revalidating (with its project) before the write. */
export async function mutateOperation(
  home: string,
  id: string,
  fn: (op: Operation) => Operation,
): Promise<Operation> {
  const file = operationFile(home, id);
  await requireFile(file);
  const release = await lock(file, { ...LOCK_OPTS });
  try {
    const stored = await migrateWorkflowLocked(home, id, file);
    const project = await readProjectOrNull(home, projectIdOf(stored));
    const resolved = validateOperationDoc(stored, file, project).operation;
    const next = asInput(() => fn(resolved));
    const nextProject =
      next.project === resolved.project
        ? project
        : await readProjectOrNull(home, next.project);
    // The stored document was valid when read, so a rejection now is the edit's.
    const { doc, text } = asInput(() => {
      const doc = validateOperationDoc(storedFromResolved(next, nextProject), file, nextProject);
      return { doc, text: serializeOperation(doc.stored) };
    });
    await writeFileAtomic(file, text);
    return doc.operation;
  } finally {
    await release();
  }
}

export async function archiveOperation(home: string, id: string, now: Date): Promise<string> {
  const stamp = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\.\d{3}Z$/, "");
  const name = `${id}-${stamp}`;
  const source = operationDir(home, id);
  const destination = join(archiveDir(home), name);
  await mkdir(archiveDir(home), { recursive: true, mode: 0o700 });
  const file = operationFile(home, id);
  await requireFile(file);
  // Lock a sibling of the operation directory: rename() below moves the whole
  // directory, so a lock inside it would travel to the archive and stop
  // covering the live document.
  const release = await lock(join(source, "..", `${id}.archive.lock`), { ...LOCK_OPTS });
  try {
    const stored = await migrateWorkflowLocked(home, id, file);
    const project = await readProjectOrNull(home, projectIdOf(stored));
    const operation = validateOperationDoc(stored, file, project).operation;
    // Archives must read forever: write the resolved document (every field
    // materialized) so a deleted project cannot strand the record.
    const resolved = validateOperationDoc(operation, file, null).stored;
    await writeFileAtomic(file, serializeOperation(resolved));
    await rename(source, destination);
  } catch (error) {
    throw new Error(`Cannot archive operation at ${source}: ${String(error)}`);
  } finally {
    await release();
  }
  return name;
}
