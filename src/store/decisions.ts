import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Contact, ContactDerived, TerminalRef } from "../core/types.ts";
import { operationDir } from "../paths.ts";

/** The decision agent's answer file and the pane record live beside each other per ticket. */
export function decisionsDir(home: string, opId: string): string {
  return join(operationDir(home, opId), "decisions");
}

// A ticket becomes a file name; encode so tracker ids like owner/repo#12 stay one entry.
const file = (ticket: string) => encodeURIComponent(ticket);

export function decisionPath(home: string, opId: string, ticket: string): string {
  return join(decisionsDir(home, opId), `${file(ticket)}.json`);
}

function panePath(home: string, opId: string, ticket: string): string {
  return join(decisionsDir(home, opId), `${file(ticket)}.pane.json`);
}
/** The pane's omp session transcripts (`--session-dir`): spend the board can attribute to the ticket. */
export function decisionSessionsDir(home: string, opId: string, ticket: string): string {
  return join(decisionsDir(home, opId), `${file(ticket)}.sessions`);
}


export interface DecisionPane {
  terminal: TerminalRef;
  startedAt: string;
  /** Set once an unreadable answer was recorded; the operator fixes or closes the pane. */
  error?: string;
}

export async function writeDecisionPane(home: string, opId: string, ticket: string, pane: DecisionPane): Promise<void> {
  await mkdir(decisionsDir(home, opId), { recursive: true, mode: 0o700 });
  await writeFile(panePath(home, opId, ticket), `${JSON.stringify(pane, null, 2)}\n`, { mode: 0o600 });
}

export async function readDecisionPane(home: string, opId: string, ticket: string): Promise<DecisionPane | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(panePath(home, opId, ticket), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const pane = raw as Record<string, unknown>;
    const terminal = pane.terminal;
    if (typeof terminal !== "object" || terminal === null) return null;
    const ref = terminal as Record<string, unknown>;
    if (typeof ref.handle !== "string" || typeof ref.incarnationId !== "string") return null;
    if (typeof pane.startedAt !== "string") return null;
    if (pane.error !== undefined && typeof pane.error !== "string") return null;
    return raw as DecisionPane;
  } catch {
    return null;
  }
}

/** Tickets (decoded) with a `.pane.json` record, whatever state the pane itself is in. */
export async function listDecisionPanes(home: string, opId: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(decisionsDir(home, opId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((e) => e.endsWith(".pane.json")).map((e) => decodeURIComponent(e.slice(0, -".pane.json".length)));
}

export async function removeDecisionPane(home: string, opId: string, ticket: string): Promise<void> {
  await rm(panePath(home, opId, ticket), { force: true });
}

export const MAX_RATIONALE = 4000;

export interface DecisionDoc {
  choice: string;
  rationale?: string;
}

/**
 * The agent's answer, checked against the contact: with options the choice must be one of them;
 * without options it is free text (1..200 chars). Throws with the reason when invalid.
 */
export function validateDecision(doc: unknown, contact: Contact): DecisionDoc {
  if (typeof doc !== "object" || doc === null) throw new Error("expected a JSON object");
  const d = doc as Record<string, unknown>;
  if (typeof d.choice !== "string" || d.choice.length === 0) throw new Error("choice must be a non-empty string");
  if (contact.options) {
    if (!contact.options.includes(d.choice)) throw new Error(`choice must be one of: ${contact.options.join(", ")}`);
  } else if (d.choice.length > 200) {
    throw new Error("choice must be at most 200 characters");
  }
  if (d.rationale !== undefined && (typeof d.rationale !== "string" || d.rationale.length > MAX_RATIONALE))
    throw new Error(`rationale must be a string of at most ${MAX_RATIONALE} characters`);
  return { choice: d.choice, ...(d.rationale !== undefined ? { rationale: d.rationale as string } : {}) };
}

export async function readDecisionDoc(home: string, opId: string, ticket: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(decisionPath(home, opId, ticket), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The prompt the decision pane runs: context in, JSON answer out, nothing else touched. */
export function decisionPrompt(i: {
  home: string;
  opId: string;
  contact: Contact;
  brief: string | null;
  notes: string | null;
  /** The operation's other decisions, newest last. */
  decided: Array<{ ticket: string; decision: NonNullable<ContactDerived["decision"]> }>;
}): string {
  const { contact } = i;
  const out = decisionPath(i.home, i.opId, contact.ticket);
  const lines = [
    `Decide ${contact.ticket}: ${contact.title ?? contact.ticket}.`,
    ...(contact.description ? [`Description:\n${contact.description}`] : []),
    ...(contact.options
      ? [
          `Options: ${contact.options.map((o) => `"${o}"`).join(", ")}` +
            (contact.recommended ? ` (recommended: "${contact.recommended}")` : "") +
            ". The choice must be one of them exactly.",
        ]
      : ["There are no preset options: the choice is a short free-text answer (at most 200 characters)."]),
  ];
  if (i.brief) lines.push(`Operation brief:\n${i.brief.slice(0, 4000)}`);
  if (i.notes) lines.push(`Notes:\n${i.notes.slice(0, 2000)}`);
  for (const d of i.decided)
    lines.push(`Earlier decision ${d.ticket}: "${d.decision.choice}"${d.decision.rationale ? ` — ${d.decision.rationale}` : ""}`);
  lines.push(
    `Investigate the repository and the tracker ticket ${contact.ticket} as needed. Do not edit any files ` +
      `except your answer: write ${out} as JSON {"choice": string, "rationale": string} and stop.`,
  );
  return lines.join("\n\n");
}
