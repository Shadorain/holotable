import { parseEvaluation } from "../core/evaluation.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isReport, buildReport, type OperationReport } from "../core/report.ts";
import type { Event, Operation } from "../core/types.ts";
import { validateOperationDoc } from "../core/validate-operation.ts";
import { archiveDir, operationDir } from "../paths.ts";
import { writeFileAtomic } from "./atomic.ts";
import { parseEvents } from "./events.ts";

export interface ArchiveEntry {
  key: string;
  report: OperationReport;
  events: Event[];
}

async function readArchiveOperation(path: string): Promise<Operation> {
  const file = join(path, "operation.json");
  const text = await readFile(file, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in operation at ${file}: ${String(error)}`);
  }
  // Archived documents are written resolved (no project needed to read them).
  return validateOperationDoc(value, file, null).operation;
}

async function readArchiveEvents(path: string): Promise<Event[]> {
  const file = join(path, "events.jsonl");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return parseEvents(text, file);
}

async function readArchiveBrief(path: string): Promise<string | null> {
  try {
    return await readFile(join(path, "brief.md"), "utf8");
  } catch {
    return null;
  }
}

async function readArchiveNotes(path: string): Promise<string | null> {
  try {
    return await readFile(join(path, "notes.md"), "utf8");
  } catch {
    return null;
  }
}

/** One archive directory's record: the persisted report, or one rebuilt from its files (never written back). */
async function reportFor(path: string, now: Date): Promise<OperationReport | null> {
  try {
    const stored = await readFile(join(path, "report.json"), "utf8");
    const value: unknown = JSON.parse(stored);
    if (isReport(value)) {
      if (value.evaluation === undefined) return value;
      const evaluation = parseEvaluation(value.evaluation);
      const { evaluation: _invalid, ...base } = value;
      return evaluation ? { ...base, evaluation } : base;
    }
  } catch {
    // Older archives have no report.json; a malformed one is rebuilt below.
  }
  try {
    const [operation, events, brief, notesText] = await Promise.all([readArchiveOperation(path), readArchiveEvents(path), readArchiveBrief(path), readArchiveNotes(path)]);
    return buildReport(operation, events, now, brief, notesText);
  } catch {
    return null;
  }
}

/** The archived operation dirs, newest close first. Directories that cannot produce a report are skipped. */
export async function listArchive(home: string, now: Date): Promise<ArchiveEntry[]> {
  let names: string[];
  try {
    names = await readdir(archiveDir(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: ArchiveEntry[] = [];
  for (const name of names) {
    const path = join(archiveDir(home), name);
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory()) continue;
    const report = await reportFor(path, now);
    if (!report) continue;
    const events = await readArchiveEvents(path).catch(() => [] as Event[]);
    entries.push({ key: name, report, events });
  }
  entries.sort((a, b) => b.report.closedAt.localeCompare(a.report.closedAt) || b.key.localeCompare(a.key));
  return entries;
}

/** The key must name a real archive entry: that check alone makes `..` and slashes dead ends. */
export async function readArchive(home: string, key: string, now: Date): Promise<ArchiveEntry | null> {
  let names: string[];
  try {
    names = await readdir(archiveDir(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!names.includes(key)) return null;
  const path = join(archiveDir(home), key);
  const report = await reportFor(path, now);
  if (!report) return null;
  const events = await readArchiveEvents(path).catch(() => [] as Event[]);
  return { key, report, events };
}

/** report.json next to the still-open operation's files; archiveOperation then moves them together. */
export async function writeReport(home: string, opId: string, report: OperationReport): Promise<void> {
  const dir = operationDir(home, opId);
  const target = join(dir, "report.json");
  try {
    await writeFileAtomic(target, `${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    throw new Error(`Cannot write report at ${target}: ${String(error)}`);
  }
}
