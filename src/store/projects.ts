import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { asInput, ConflictError } from "../core/errors.ts";
import type { Project } from "../core/types.ts";
import { validateProject } from "../core/validate-project.ts";
import { projectDir, projectFile, projectsDir } from "../paths.ts";
import { createFileAtomic, writeFileAtomic } from "./atomic.js";

const MAX_PROJECT_BYTES = 64 * 1024;

/** Validated and serialized for disk; a rejection is the caller's input (create or edit). */
function serializeProject(project: Project, target: string): { validated: Project; text: string } {
  return asInput(() => {
    const validated = validateProject(project, target);
    const text = `${JSON.stringify(validated, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_PROJECT_BYTES) throw new Error("project exceeds 64 KiB");
    return { validated, text };
  });
}

export async function createProject(home: string, project: Project): Promise<Project> {
  const target = projectFile(home, project.id);
  const { validated, text } = serializeProject(project, target);
  await mkdir(projectDir(home, project.id), { recursive: true, mode: 0o700 });
  try {
    await createFileAtomic(target, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ConflictError(`Project ${project.id} already exists`);
    throw error;
  }
  return validated;
}

export async function readProject(home: string, id: string): Promise<Project> {
  const path = projectFile(home, id);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error(`Cannot read project at ${path}: ${String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in project at ${path}: ${String(error)}`);
  }
  return validateProject(value, path);
}

/** null when the project does not exist. */
export async function readProjectOrNull(home: string, id: string | null): Promise<Project | null> {
  if (id === null) return null;
  try {
    return await readProject(home, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export async function listProjects(home: string): Promise<Project[]> {
  let entries: string[];
  try {
    entries = await readdir(projectsDir(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: Project[] = [];
  for (const entry of entries.sort()) {
    const path = join(projectsDir(home), entry, "project.json");
    try {
      rows.push(validateProject(JSON.parse(await readFile(path, "utf8")), path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
  }
  return rows;
}

/** Mutate project.json under its lock, revalidating before the write. */
export async function mutateProject(
  home: string,
  id: string,
  fn: (project: Project) => Project,
): Promise<Project> {
  const target = projectFile(home, id);
  const release = await lock(target, { realpath: false, stale: 10_000, retries: { retries: 5, minTimeout: 50 } });
  try {
    const current = await readProject(home, id);
    const { validated, text } = serializeProject(asInput(() => fn(current)), target);
    await writeFileAtomic(target, text);
    return validated;
  } finally {
    await release();
  }
}

/** Delete the project directory. Callers refuse while an operation still names it. */
export async function removeProjectDir(home: string, id: string): Promise<void> {
  await rm(projectDir(home, id), { recursive: true, force: true });
}
