import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseSeed, type SeedShape } from "../core/seed.ts";
import { FRONTENDS, type Frontend, type TerminalRef } from "../core/types.ts";
import { draftDir, draftsDir } from "../paths.ts";

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

\`\`\`json
{
  "name": "Short operation name",
  "brief": "# Markdown\\nWhat this campaign is and why. Optional.",
  "notes": "## Checklist\\n- [ ] A task line\\n- [x] A done task. Optional.",
  "zones": [{ "id": "zone-id", "label": "ZONE LABEL" }],
  "contacts": [
    {
      "ticket": "TICKET-1",
      "title": "What the mission does",
      "zone": "zone-id",
      "kind": "implement",
      "blockedBy": ["TICKET-0"]
    },
    {
      "ticket": "TICKET-2",
      "title": "A question someone has to answer",
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
  blockedBy lists tickets of contacts in this file that must land first.
- decision contacts may list 2-8 options and a recommended one (must be one of the options);
  leave both out when the source does not say.
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
  - Dependencies: \`lin relations list CHR-123 --json\`; a "blocks" relation from A to B means B's
    blockedBy includes A. Only keep blockers that are contacts in this file.
  - Skip issues whose state is Done, Canceled or Duplicate.`,
  github: "GitHub issue references like owner/repo#42 or #42. For GitHub links, fetch them with gh.",
  none: "short slugs matching /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.",
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

export async function removeDraft(home: string, id: string): Promise<void> {
  assertDraftId(id);
  await rm(draftDir(home, id), { recursive: true, force: true });
}

/** The prompt the draft pane runs: input.md in, seed.json out, nothing else touched. */
export function draftPrompt(home: string, id: string): string {
  assertDraftId(id);
  const dir = draftDir(home, id);
  return (
    `Read ${join(dir, "input.md")} and anything it links ` +
    `(use the tracker's CLI for ticket references). ` +
    `Then write a seed JSON to ${join(dir, "seed.json")} exactly per ${join(dir, "SCHEMA.md")}. ` +
    `Do not change any code or files elsewhere. When seed.json is written, say done.`
  );
}

export function newDraftId(): string {
  return `draft-${randomBytes(4).toString("hex")}`;
}
