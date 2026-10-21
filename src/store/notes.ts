import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";
import { InputError } from "../core/errors.ts";
import { operationDir } from "../paths.ts";
import { writeFileAtomic } from "./atomic.ts";

const MAX_NOTES = 256 * 1024;

export function notesFile(home: string, id: string): string {
  return join(operationDir(home, id), "notes.md");
}

/** First 12 hex of sha256 — the revision the API hands out and takes back as `base`. */
export function notesRevision(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/** A missing file reads as the empty string (with the empty string's revision). */
export async function readNotes(home: string, id: string): Promise<{ text: string; revision: string }> {
  try {
    const text = await readFile(notesFile(home, id), "utf8");
    return { text, revision: notesRevision(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { text: "", revision: notesRevision("") };
    throw new Error(`Cannot read notes at ${notesFile(home, id)}: ${String(error)}`);
  }
}

export async function notesExists(home: string, id: string): Promise<boolean> {
  try {
    await access(notesFile(home, id));
    return true;
  } catch {
    return false;
  }
}

/** The edit was made against a notes revision that is no longer current; the API maps it to 409. */
export class StaleRevisionError extends Error {
  constructor(current: string) {
    super(`stale(${current})`);
    this.name = "StaleRevisionError";
  }
}

/** Compare-and-swap write: `base` must be the revision the edit was made against. */
export async function writeNotes(
  home: string,
  id: string,
  text: string,
  base: string,
): Promise<{ text: string; revision: string }> {
  if (Buffer.byteLength(text) > MAX_NOTES) throw new InputError("notes exceed 256 KiB");
  const dir = operationDir(home, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Lock notes.md itself: proper-lockfile does not need the file to exist and the
  // notes.md.lock entry lands inside the operation dir, not as a sibling of it.
  const release = await lock(join(dir, "notes.md"), { realpath: false, stale: 10_000, retries: { retries: 5, minTimeout: 50 } });
  try {
    const current = await readNotes(home, id);
    if (base !== current.revision) throw new StaleRevisionError(current.revision);
    await writeFileAtomic(notesFile(home, id), text);
    return { text, revision: notesRevision(text) };
  } finally {
    await release();
  }
}
