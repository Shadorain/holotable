import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCloserReview } from "../core/closer.ts";
import type { CloserReview } from "../core/types.ts";
import { operationDir } from "../paths.ts";

const MAX_REPORT = 64 * 1024;

function closerDir(home: string, opId: string): string {
  return join(operationDir(home, opId), "closer");
}

/** The closer's Markdown copy of its report (inside the operation directory, like decision answers). */
export function closerReportPath(home: string, opId: string, ticket: string): string {
  return join(closerDir(home, opId), `${encodeURIComponent(ticket)}.md`);
}

/** The closer's structured review, next to the Markdown copy. */
export function closerReviewPath(home: string, opId: string, ticket: string): string {
  return join(closerDir(home, opId), `${encodeURIComponent(ticket)}.json`);
}

/** Make sure the closer can write its report before its pane starts. */
export async function ensureCloserReportDir(home: string, opId: string): Promise<void> {
  await mkdir(closerDir(home, opId), { recursive: true, mode: 0o700 });
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The closer's Markdown report, capped; null until the mission writes one. */
export async function readCloserReport(home: string, opId: string, ticket: string): Promise<string | null> {
  const text = await readOptional(closerReportPath(home, opId, ticket));
  if (text === null) return null;
  return text.length > MAX_REPORT ? `${text.slice(0, MAX_REPORT)}\n\n(report truncated)` : text;
}

/** The closer's JSON review: `{review: null, error: null}` until written, `error` when it is not one. */
export async function readCloserReview(home: string, opId: string, ticket: string): Promise<{ review: CloserReview | null; error: string | null }> {
  const text = await readOptional(closerReviewPath(home, opId, ticket));
  if (text === null) return { review: null, error: null };
  const name = `closer/${encodeURIComponent(ticket)}.json`;
  if (text.length > MAX_REPORT) return { review: null, error: `${name} is over 64 KiB` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { review: null, error: `${name} is not valid JSON` };
  }
  const review = parseCloserReview(raw);
  return review ? { review, error: null } : { review: null, error: `${name} is not a v1 closer report (needs v: 1 and a summary)` };
}
