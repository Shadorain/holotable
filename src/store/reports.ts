import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MissionReport } from "../core/types.ts";
import { parseMissionReport } from "../core/validate-status.ts";
import { operationDir } from "../paths.ts";
import { writeFileAtomic } from "./atomic.ts";

/**
 * A contact's latest mission report (status `report`), kept so the card still shows it after the
 * contact lands and its status file is gone. One file per ticket; the newest report wins.
 */
export function contactReportPath(home: string, opId: string, ticket: string): string {
  return join(operationDir(home, opId), "reports", `${encodeURIComponent(ticket)}.json`);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A saved file's report; null when it no longer reads as one (it is replaced on the next save). */
function parseSaved(text: string): MissionReport | null {
  try {
    return parseMissionReport(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The saved report; null when none was saved or the file no longer reads as one. */
export async function readContactReport(home: string, opId: string, ticket: string): Promise<MissionReport | null> {
  const text = await readText(contactReportPath(home, opId, ticket));
  return text === null ? null : parseSaved(text);
}

/**
 * Saves the report unless the file already holds exactly it; true when it wrote. A producer can briefly
 * publish no work items for a revision it listed before (a beads pane after a restart), so an empty `work`
 * keeps the saved list of the same revision.
 */
export async function saveContactReport(home: string, opId: string, ticket: string, report: MissionReport): Promise<boolean> {
  const path = contactReportPath(home, opId, ticket);
  const saved = await readText(path);
  let next = report;
  if (saved !== null && report.work.length === 0) {
    const previous = parseSaved(saved);
    if (previous && previous.revision === report.revision && previous.work.length) next = { ...report, work: previous.work };
  }
  const text = `${JSON.stringify(next)}\n`;
  if (saved === text) return false;
  await writeFileAtomic(path, text);
  return true;
}
