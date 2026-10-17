import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseSeed, type SeedShape } from "../core/seed.ts";
import { FRONTENDS, type Frontend, type TerminalRef } from "../core/types.ts";
import { draftDir, draftsDir } from "../paths.ts";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { summarizePaneSessions } from "./pane-usage.ts";

export const MAX_DRAFT_INPUT = 64 * 1024;

const DRAFT_ID = /^draft-[0-9a-f]{8}$/;

/** Draft ids become directory names; anything else is a path escape. */
function assertDraftId(id: string): void {
  if (!DRAFT_ID.test(id)) throw new Error(`Invalid draft id "${id}"`);
}

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

/** The seed format the drafting agent writes, pasted into the pane prompt via SCHEMA.md. */
export function seedSchema(trackerHint: string): string {
  return `# Draft seed format

Write your answer as JSON to seed.json next to this file. Nothing else on disk may change.

## Import a plan or develop an idea

Read the input and inspect the selected repository read-only before drafting. A link or an
existing plan is a source to import; a rough goal is a request to develop a scoped execution
plan, not a reason to return an empty board.

- For an existing plan, preserve its parallel workstreams, explicit prerequisites, ownership
  boundaries, decisions and acceptance/release gates. A suggested running order is not automatically
  a hard dependency. Do not serialize independent work or reopen historical completed tickets.
- For an idea, identify the affected code and existing conventions, split the goal into independently
  verifiable missions, and derive only necessary dependencies. Put scope, exclusions, acceptance
  checks and proposed file ownership in the brief, organized by contact id.
- Use short human-readable titles (~3–8 words, not acceptance prose) for every contact. Put the full
  mission scope, instructions, and observable acceptance criteria in description. Local missions launch
  using the description, while the short title identifies the contact on the board.
- Use decision contacts for material unresolved choices. For a new idea, propose concrete options
  and a recommendation only when supported by the repository and the user's constraints.
  Downstream work that depends on the choice must be blocked by that decision.
- With a ticket tracker, use only fetched real issues. Never invent ticket ids or create/update
  tracker issues while drafting. If new work has no tickets, explain in notes that a local
  (tracker: none) project is needed, or that the operator must create tickets first.
- If a source cannot be read, report the missing source in notes; do not pretend it was imported.
  Do not execute the plan, install dependencies, run services, or modify the repository.

\`\`\`json
{
  "name": "Short operation name",
  "brief": "# Markdown\\nWhat this campaign is and why. Optional.",
  "notes": "## Checklist\\n- [ ] A task line\\n- [x] A done task. Optional.",
  "zones": [{ "id": "zone-id", "label": "ZONE LABEL" }],
  "contacts": [
    {
      "ticket": "TICKET-1",
      "title": "Short title (~3–8 words)",
      "description": "Full mission instructions: action, scope, and observable acceptance criteria.",
      "zone": "zone-id",
      "kind": "implement",
      "blockedBy": ["TICKET-0"]
    },
    {
      "ticket": "TICKET-2",
      "title": "Short decision question (~3–8 words)",
      "description": "Full context and question for the decision.",
      "zone": "zone-id",
      "kind": "decision",
      "options": ["First answer", "Second answer"],
      "recommended": "First answer"
    }
  ]
}
\`\`\`

- zones: at most 8; id is lowercase letters, digits and dashes (1-24 chars); label 1-24 chars.
  Group by area of the codebase or workstream (a project's milestones or labels are a good start).
- contacts: at most 200; kind is implement, audit, decision or conflict (default implement);
  title is a short human-readable label (~3–8 words); description carries the full task scope
  and acceptance criteria; blockedBy lists tickets of contacts in this file that must land first.
- decision contacts may list 2-8 options and a recommended one (must be one of the options);
  preserve source options when importing; for generated ideas follow the decision rules above.
- Leave out work that is already finished or cancelled.
- Ticket ids: ${trackerHint}
- Every contact's zone must be a zone id in this file. Only name, brief, notes, zones and
  contacts are read; leave out what you cannot fill honestly.
`;
}

const TRACKER_HINTS: Record<string, string> = {
  linear: `Linear ticket ids like CHR-157. Fetch Linear references with the \`lin\` CLI, never guess:
  - A project link (linear.app/<workspace>/project/<slug>-<id>): \`lin projects list --json\` to find the
    project whose name matches the slug, then \`lin projects issues "<project name>" --json --limit 200\`.
  - An issue: \`lin issues get CHR-123 --json\` (description, labels, state, parent).
  - A document link (linear.app/<workspace>/document/<slug>-<id>): fetch its full content with
    \`lin docs get <id> --json\` using the trailing id from the URL, then fetch its referenced issues
    and relations. Use the document's explicit lanes and gates as well as the live ticket states.
  - Dependencies: \`lin relations list CHR-123 --json\`; a "blocks" relation from A to B means B's
    blockedBy includes A. Only keep blockers that are contacts in this file.
  - Skip issues whose state is Done, Canceled or Duplicate.`,
  github: "GitHub issue references like owner/repo#42 or #42. For GitHub links, fetch them with gh.",
  none: "local short slugs matching /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/. Generate stable descriptive ids for new missions; no external tickets are required. Linear source documents can still be read with `lin docs get <id> --json`, without creating Linear issues.",
};

export function schemaFor(tracker: string): string {
  return seedSchema(TRACKER_HINTS[tracker] ?? TRACKER_HINTS.none!);
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
  if (!DRAFT_ID.test(id)) return null;
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
  if (!DRAFT_ID.test(id)) return null;
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
        if (!row || row.v !== 1 || typeof row.id !== "string" || !DRAFT_ID.test(row.id) ||
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

/** The prompt the draft pane runs: input.md in, seed.json out, nothing else touched. */
export function draftPrompt(home: string, id: string): string {
  assertDraftId(id);
  const dir = draftDir(home, id);
  return (
    `Read ${join(dir, "SCHEMA.md")} first, then ${join(dir, "input.md")} and its relevant sources ` +
    `(use lin for Linear documents and issues, gh for GitHub references). Inspect the current repository read-only. ` +
    `Import an existing execution plan or develop the rough idea into scoped, verifiable missions, following the schema's planning rules ` +
    `(short titles of ~3–8 words and full descriptions for executable scope and acceptance criteria). ` +
    `Write the seed JSON to ${join(dir, "seed.json")}. ` +
    `Do not change any code or files elsewhere, execute work, or mutate external trackers. When seed.json is written, say done.`
  );
}

export function newDraftId(): string {
  return `draft-${randomBytes(4).toString("hex")}`;
}
