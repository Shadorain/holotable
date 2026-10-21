import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseSeed, type SeedShape } from "../core/seed.ts";
import { FRONTENDS, type Frontend, type TerminalRef } from "../core/types.ts";
import { assertDraftId, draftDir, draftsDir, isDraftId } from "../paths.ts";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { summarizePaneSessions } from "./pane-usage.ts";
import { schemaFor } from "./draft-prompts.ts";

export const MAX_DRAFT_INPUT = 64 * 1024;

/** Loose draft.json on disk must still be a DraftDoc before its terminal/frontend are trusted. */
function asDraftDoc(raw: unknown): DraftDoc | null {
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as Record<string, unknown>;
  if (doc.state !== "open") return null;
  if (!FRONTENDS.includes(doc.frontend as Frontend)) return null;
  if (typeof doc.repo !== "string" || !isAbsolute(doc.repo)) return null;
  if (typeof doc.createdAt !== "string" || Number.isNaN(Date.parse(doc.createdAt))) return null;
  if (doc.worktreeRoot !== undefined && typeof doc.worktreeRoot !== "string") return null;
  const terminal = doc.terminal;
  if (terminal !== null) {
    if (typeof terminal !== "object" || terminal === null) return null;
    const ref = terminal as Record<string, unknown>;
    if (typeof ref.handle !== "string" || typeof ref.incarnationId !== "string") return null;
  }
  return raw as DraftDoc;
}

export interface DraftDoc {
  /** "open" while the pane may still be writing; terminal is recorded once openTerminal returned. */
  state: "open";
  frontend: Frontend;
  repo: string;
  worktreeRoot?: string;
  terminal: TerminalRef | null;
  createdAt: string;
}

const META = "draft.json";

function metaPath(dir: string): string {
  return join(dir, META);
}

export async function createDraftDir(
  home: string,
  id: string,
  input: { text: string; repo: string; frontend: Frontend; tracker: string; worktreeRoot?: string; createdAt: string },
): Promise<string> {
  assertDraftId(id);
  const dir = draftDir(home, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const doc: DraftDoc = {
    state: "open",
    frontend: input.frontend,
    repo: input.repo,
    ...(input.worktreeRoot !== undefined ? { worktreeRoot: input.worktreeRoot } : {}),
    terminal: null,
    createdAt: input.createdAt,
  };
  await writeFile(join(dir, "input.md"), input.text, { mode: 0o600 });
  await writeFile(join(dir, "SCHEMA.md"), schemaFor(input.tracker), { mode: 0o600 });
  await writeFile(metaPath(dir), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  return dir;
}

/** Best-effort record: a malformed or missing draft reads as null. */
export async function readDraftDoc(home: string, id: string): Promise<DraftDoc | null> {
  if (!isDraftId(id)) return null;
  try {
    const raw: unknown = JSON.parse(await readFile(metaPath(draftDir(home, id)), "utf8"));
    return asDraftDoc(raw);
  } catch {
    return null;
  }
}

export async function recordDraftTerminal(home: string, id: string, terminal: TerminalRef): Promise<void> {
  assertDraftId(id);
  const doc = await readDraftDoc(home, id);
  if (!doc) return;
  await writeFile(metaPath(draftDir(home, id)), `${JSON.stringify({ ...doc, terminal }, null, 2)}\n`, { mode: 0o600 });
}

export interface DraftEntry {
  id: string;
  /** A readable seed.json parses: "ready"; an unparseable one: "invalid"; none yet: "running". */
  state: "running" | "ready" | "invalid";
  createdAt: string;
  seed?: SeedShape;
  error?: string;
}

export async function draftEntry(home: string, id: string): Promise<DraftEntry | null> {
  if (!isDraftId(id)) return null;
  const dir = draftDir(home, id);
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return null;
  const doc = await readDraftDoc(home, id);
  const createdAt = doc?.createdAt ?? info.mtime.toISOString();
  let text: string;
  try {
    text = await readFile(join(dir, "seed.json"), "utf8");
  } catch {
    return { id, state: "running", createdAt };
  }
  try {
    return { id, state: "ready", createdAt, seed: parseSeed(text, "seed.json") };
  } catch (error) {
    return { id, state: "invalid", createdAt, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Drafts left on disk (e.g. the service restarted): id, state and when they were made. */
export async function listDrafts(home: string): Promise<DraftEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(draftsDir(home));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: DraftEntry[] = [];
  for (const entry of entries.sort()) {
    const draft = await draftEntry(home, entry);
    if (draft) out.push(draft);
  }
  return out;
}
export interface DraftUsage {
  tokens: number;
  costUsd: number | null;
  sessions: number;
  partial: boolean;
}

/** Persist before deleting transcripts. A leading newline isolates a crash-torn previous row. */
export async function recordDraftUsage(home: string, id: string, at: string): Promise<void> {
  assertDraftId(id);
  const usage = await summarizePaneSessions(join(draftDir(home, id), "sessions"));
  if (!usage) return;
  const { tokens, costUsd, sessions, malformedLines, truncated } = usage;
  await appendFile(join(draftsDir(home), "usage.jsonl"),
    `\n${JSON.stringify({ v: 1, at, id, tokens, costUsd, sessions, malformedLines, truncated })}\n`, { mode: 0o600 });
}

/** Per-draft high-water marks make repeated closes and crash retries idempotent. */
export async function readDraftUsage(home: string): Promise<DraftUsage | null> {
  const path = join(draftsDir(home), "usage.jsonl");
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const out: DraftUsage = { tokens: 0, costUsd: null, sessions: 0, partial: false };
  const seen = new Map<string, { tokens: Record<string, number>; costUsd: number | null; sessions: number }>();
  const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!row || row.v !== 1 || typeof row.id !== "string" || !isDraftId(row.id) ||
            !row.tokens || !keys.every(k => count(row.tokens[k])) || !count(row.sessions) ||
            !(row.costUsd === null || typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0) ||
            (row.malformedLines !== undefined && !count(row.malformedLines)) ||
            (row.truncated !== undefined && typeof row.truncated !== "boolean")) {
          out.partial = true;
          continue;
        }
        out.partial ||= row.truncated === true || (row.malformedLines ?? 0) > 0 || row.costUsd === null;
        const previous = seen.get(row.id);
        for (const k of keys) out.tokens += Math.max(0, row.tokens[k] - (previous?.tokens[k] ?? 0));
        if (row.costUsd !== null) out.costUsd = (out.costUsd ?? 0) + Math.max(0, row.costUsd - (previous?.costUsd ?? 0));
        out.sessions += Math.max(0, row.sessions - (previous?.sessions ?? 0));
        seen.set(row.id, {
          tokens: Object.fromEntries(keys.map(k => [k, Math.max(row.tokens[k], previous?.tokens[k] ?? 0)])),
          costUsd: row.costUsd === null ? previous?.costUsd ?? null : Math.max(row.costUsd, previous?.costUsd ?? 0),
          sessions: Math.max(row.sessions, previous?.sessions ?? 0),
        });
      } catch {
        out.partial = true;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return seen.size || out.partial ? out : null;
}


export async function removeDraft(home: string, id: string): Promise<void> {
  assertDraftId(id);
  await rm(draftDir(home, id), { recursive: true, force: true });
}

export function newDraftId(): string {
  return `draft-${randomBytes(4).toString("hex")}`;
}
