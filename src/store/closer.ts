import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { operationDir } from "../paths.ts";

const MAX_REPORT = 64 * 1024;

/** The closer mission writes its review report here (inside the operation directory, like decision answers). */
export function closerReportPath(home: string, opId: string, ticket: string): string {
  return join(operationDir(home, opId), "closer", `${encodeURIComponent(ticket)}.md`);
}

/** Make sure the closer can write its report before its pane starts. */
export async function ensureCloserReportDir(home: string, opId: string): Promise<void> {
  await mkdir(join(operationDir(home, opId), "closer"), { recursive: true, mode: 0o700 });
}

/** The closer's report, capped; null until the mission writes one. */
export async function readCloserReport(home: string, opId: string, ticket: string): Promise<string | null> {
  try {
    const text = await readFile(closerReportPath(home, opId, ticket), "utf8");
    return text.length > MAX_REPORT ? `${text.slice(0, MAX_REPORT)}\n\n(report truncated)` : text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
