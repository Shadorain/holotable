import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCloserReview } from "../core/closer.ts";
import type { CloserReview } from "../core/types.ts";
import { operationDir } from "../paths.ts";

const MAX_REPORT = 64 * 1024;

/** `closer/` inside an operation directory, open or archived: archiving moves the whole directory with it. */
function closerDir(opDir: string): string {
  return join(opDir, "closer");
}

/** The closer's Markdown copy of its report (inside the operation directory, like decision answers). */
export function closerReportPath(home: string, opId: string, ticket: string): string {
  return join(closerDir(operationDir(home, opId)), `${encodeURIComponent(ticket)}.md`);
}

/** The closer's structured review, next to the Markdown copy. */
export function closerReviewPath(home: string, opId: string, ticket: string): string {
  return join(closerDir(operationDir(home, opId)), `${encodeURIComponent(ticket)}.json`);
}

/** Make sure the closer can write its report before its pane starts. */
export async function ensureCloserReportDir(home: string, opId: string): Promise<void> {
  await mkdir(closerDir(operationDir(home, opId)), { recursive: true, mode: 0o700 });
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** What a closer wrote: its Markdown report (capped), its JSON review, and why the review is unreadable. */
export interface CloserFiles {
  report: string | null;
  review: CloserReview | null;
  /** Why closer/<ticket>.json, though written, could not be read as a review. */
  error: string | null;
}

/** The closer's files in operation directory `opDir` (open, or under archive/); all null until it writes them. */
export async function readCloserFilesAt(opDir: string, ticket: string): Promise<CloserFiles> {
  const name = encodeURIComponent(ticket);
  const [markdown, json] = await Promise.all([readOptional(join(closerDir(opDir), `${name}.md`)), readOptional(join(closerDir(opDir), `${name}.json`))]);
  const report = markdown !== null && markdown.length > MAX_REPORT ? `${markdown.slice(0, MAX_REPORT)}\n\n(report truncated)` : markdown;
  if (json === null) return { report, review: null, error: null };
  const file = `closer/${name}.json`;
  if (json.length > MAX_REPORT) return { report, review: null, error: `${file} is over 64 KiB` };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { report, review: null, error: `${file} is not valid JSON` };
  }
  const review = parseCloserReview(raw);
  return review ? { report, review, error: null } : { report, review: null, error: `${file} is not a v1 closer report (needs v: 1 and a summary)` };
}

/** The closer's files in an open operation. */
export function readCloserFiles(home: string, opId: string, ticket: string): Promise<CloserFiles> {
  return readCloserFilesAt(operationDir(home, opId), ticket);
}
