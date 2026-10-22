import { contactDerived, foldEvents } from "./fold.ts";
import { taskLines } from "./notes.ts";
import type { CloserCoverage, CloserReview, CloserVerdict, Contact, Derived, Event, Operation } from "./types.ts";
import { isRecord } from "./validate.ts";

/** The ticket a closer gets when the operator does not name one. */
export const CLOSER_TICKET = "CLOSER";
export const CLOSER_TITLE = "Closer review";

const MAX_LANDED = 40;
const MAX_DECISIONS = 20;
const MAX_CONFLICTS = 20;
const MAX_TASKS = 40;
const MAX_PATHS = 6;
const MAX_RECOMMENDATIONS = 3;
const MAX_BRIEF_CHARS = 6000;
const MAX_TEXT_CHARS = 300;
const MAX_PR_NOTES_CHARS = 2000;

export function closerOf<C extends Pick<Contact, "kind">>(holder: { contacts: readonly C[] }): C | undefined {
  return holder.contacts.find((c) => c.kind === "closer");
}

/** Why a closer is still blocked: one line, never a list of every ticket in the operation. */
export function closerWait(left: number): string {
  return `Waits for the rest of the operation to land (${left} left)`;
}

export interface CloserBriefInput {
  operation: Operation;
  closer: Contact;
  events: Event[];
  /** foldEvents(events) when the caller already holds it; folded here otherwise. */
  derived?: Derived;
  /** brief.md, the operator's campaign brief. */
  briefText: string | null;
  /** notes.md; its task lines become the checklist the closer verifies. */
  notesText: string | null;
  /** Intel's open recommendations, highest stake first. */
  recommendations: string[];
  /** Where the closer writes its JSON review; the board shows it on the card. */
  reportPath: string;
  /** Where it may write a Markdown copy for people. */
  markdownPath: string;
}

/** The landed missions a closer reviews, oldest landing first: each needs a verdict in its report. */
export function closerTickets(operation: Operation, derived: Derived, closerTicket: string): Contact[] {
  return operation.contacts
    .filter((c) => c.ticket !== closerTicket && (c.kind === "implement" || c.kind === "audit") && contactDerived(derived, c.ticket).landed)
    .sort((a, b) => (contactDerived(derived, a.ticket).landedAt ?? 0) - (contactDerived(derived, b.ticket).landedAt ?? 0));
}

const VERDICTS: readonly CloserVerdict[] = ["ok", "fixed", "follow-up", "not-checked"];
const RUN_OUTCOMES = ["passed", "failed", "not-run"] as const;
const SEVERITIES = ["high", "medium", "low"] as const;

const text = (raw: unknown): raw is string => typeof raw === "string" && raw.trim() !== "";
const texts = (raw: unknown): string[] | undefined => (Array.isArray(raw) ? raw.filter(text) : undefined);
const optional = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
const rows = (raw: unknown): Record<string, unknown>[] => (Array.isArray(raw) ? raw.filter(isRecord) : []);
const oneOf = <T extends string>(values: readonly T[], raw: unknown): raw is T => values.includes(raw as T);

/**
 * The closer's JSON review (v1), written by a model: lenient. Not an object, another `v` or no summary reads
 * as no review (null); a missing list reads as empty, and an entry missing its required fields is dropped.
 */
export function parseCloserReview(raw: unknown): CloserReview | null {
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.summary !== "string") return null;
  const note = (r: Record<string, unknown>, key: string) => optional(key, text(r[key]) ? r[key] : undefined);
  return {
    v: 1,
    summary: raw.summary,
    verification: rows(raw.verification).flatMap((r) =>
      text(r.command) && oneOf(RUN_OUTCOMES, r.outcome) ? [{ command: r.command, outcome: r.outcome, ...note(r, "note") }] : []),
    tickets: rows(raw.tickets).flatMap((r) =>
      text(r.ticket) && oneOf(VERDICTS, r.verdict) ? [{ ticket: r.ticket, verdict: r.verdict, ...note(r, "note") }] : []),
    fixes: rows(raw.fixes).flatMap((r) =>
      text(r.title) ? [{ title: r.title, ...optional("files", texts(r.files)), ...optional("tickets", texts(r.tickets)), ...note(r, "commit") }] : []),
    followUps: rows(raw.followUps).flatMap((r) =>
      text(r.title)
        ? [{ title: r.title, ...note(r, "detail"), ...optional("tickets", texts(r.tickets)), ...optional("severity", oneOf(SEVERITIES, r.severity) ? r.severity : undefined) }]
        : []),
    ...optional("prNotes", text(raw.prNotes) ? raw.prNotes.slice(0, MAX_PR_NOTES_CHARS) : undefined),
  };
}

/** Each landed ticket with the verdict the review gave it (`not-reported` when it gave none). */
export function closerCoverage(landed: ReadonlyArray<Pick<Contact, "ticket" | "title">>, review: CloserReview): CloserCoverage {
  const verdicts = new Map<string, CloserReview["tickets"][number]>();
  for (const entry of review.tickets) if (!verdicts.has(entry.ticket)) verdicts.set(entry.ticket, entry);
  const tickets = landed.map((c) => {
    const entry = verdicts.get(c.ticket);
    return { ticket: c.ticket, title: c.title, verdict: entry?.verdict ?? ("not-reported" as const), note: entry?.note ?? null };
  });
  return {
    tickets,
    total: tickets.length,
    checked: tickets.filter((t) => t.verdict !== "not-reported" && t.verdict !== "not-checked").length,
    fixed: tickets.filter((t) => t.verdict === "fixed").length,
    followUps: review.followUps.length,
  };
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT_CHARS ? `${flat.slice(0, MAX_TEXT_CHARS - 1)}…` : flat;
};

/** At most `max` rows, then one line naming how many were left out. */
function capped(rows: string[], max: number): string[] {
  if (rows.length <= max) return rows;
  return [...rows.slice(0, max), `- … and ${rows.length - max} more`];
}

function deliveryInstruction(operation: Operation): string {
  switch (operation.delivery) {
    case "github-pr":
      return "Commit fixes on this branch and record a local delivery. Do not push or open a pull request yourself: when the closer is marked done, Holotable opens one for these commits and lands it through the usual checks.";
    case "local-merge":
      return `Commit fixes on this branch and record a local delivery. Do not merge into \`${operation.base}\` yourself: Holotable merges this branch when it lands.`;
    case "none":
      return "Commit fixes on this branch and record a local delivery. This operation has no delivery: the operator merges it by hand.";
  }
}

/**
 * The closer mission's instructions: what landed, what was decided, what the notes promised, and how to
 * review the integrated result. Every list is bounded so a large operation still fits a system prompt.
 */
export function closerBrief(i: CloserBriefInput): string {
  const { operation, closer } = i;
  const derived = i.derived ?? foldEvents(i.events);
  const byTicket = new Map(operation.contacts.map((c) => [c.ticket, c]));
  const label = (c: Contact) => (c.title ? `${c.ticket} · ${oneLine(c.title)}` : c.ticket);

  const reviewed = closerTickets(operation, derived, closer.ticket);
  const landed = reviewed.map((c) => {
    const d = contactDerived(derived, c.ticket);
    const where = d.lastSample?.delivery?.url ?? (c.lane?.branch ? `branch ${c.lane.branch}` : "no PR or branch recorded");
    const at = d.landedAt === null ? "" : ` · landed ${new Date(d.landedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    return `- ${label(c)} (${c.kind}) — ${where}${at}`;
  });

  const decisions = operation.contacts
    .filter((c) => c.kind === "decision" && contactDerived(derived, c.ticket).decision !== null)
    .map((c) => {
      const decision = contactDerived(derived, c.ticket).decision!;
      const why = decision.rationale ? ` — ${oneLine(decision.rationale)}` : "";
      return `- ${label(c)}: **${oneLine(decision.choice)}**${why}`;
    });

  // Each conflict mission resolved the paths of the land attempt that opened it.
  const attemptPaths = new Map<string, string[]>();
  const conflictPaths = new Map<string, string[]>();
  for (const e of i.events) {
    if (e.kind === "land-attempt" && e.outcome === "conflict") attemptPaths.set(e.contact, e.paths ?? []);
    else if (e.kind === "conflict-opened") conflictPaths.set(e.conflictContact, attemptPaths.get(e.contact) ?? []);
  }
  const conflicts = operation.contacts
    .filter((c) => c.kind === "conflict" && c.conflictOf !== null && c.conflictOf !== closer.ticket)
    .map((c) => {
      const target = byTicket.get(c.conflictOf!);
      const paths = conflictPaths.get(c.ticket) ?? [];
      const shown = paths.slice(0, MAX_PATHS).join(", ");
      const more = paths.length > MAX_PATHS ? ` and ${paths.length - MAX_PATHS} more` : "";
      const d = contactDerived(derived, c.ticket);
      let state = "not landed";
      if (d.landed) state = "landed";
      else if (d.reaped) state = "abandoned";
      return `- ${c.ticket} resolved landing ${target ? label(target) : c.conflictOf}${shown ? ` in ${shown}${more}` : ""} (${state})`;
    });

  const tasks = taskLines(i.notesText).map((t) => `- [${t.done ? "x" : " "}] ${oneLine(t.text)}`);
  const recommendations = i.recommendations.slice(0, MAX_RECOMMENDATIONS).map((r) => `- ${oneLine(r)}`);

  const out: string[] = [
    `# Closer review of operation ${operation.name}`,
    "",
    `You are the closer of operation "${operation.name}" (${operation.id}). Every other contact has landed on \`${operation.base}\`; this mission checks the integrated result as a whole. Your branch starts from \`${operation.base}\`.`,
    "",
    "## What to do",
    "",
    `1. Fetch \`${operation.base}\` and run the repository's full verification (tests, typecheck, lint, build: whatever the repo's own gate is) on the integrated base.`,
    "2. Review the combined change set of the landed work below for problems between contacts: duplicated helpers, inconsistent APIs or naming, leftover TODO/FIXME/debug code, dead code from superseded approaches, docs that disagree with the code, and missing tests at the seams between contacts.",
    "3. Check the brief's acceptance criteria and every notes checklist item below against the code.",
    `4. Fix small integration problems on this branch. ${deliveryInstruction(operation)}`,
    "5. Anything larger is a follow-up: list it in your delivery summary and report with file:line evidence. Do not build it.",
    `6. Never rewrite or revert landed history: no force-push, no reverting commits already on \`${operation.base}\`.`,
    "7. If nothing needs fixing, commit nothing and say so, with the evidence: the verification you ran and what you checked.",
    "8. Check the repo's contribution rules (AGENTS.md, CONTRIBUTING) and CI workflows for PR-description requirements your changes trigger (e.g. a `Guardrail-change: <reason>` line), and put the required lines in `prNotes`: the board opens the PR with them.",
    `9. Before recording delivery, write your report as JSON to \`${i.reportPath}\` (format below), with one \`tickets\` entry per ticket under "Tickets to report": \`ok\`, \`fixed\` (you fixed something in it), \`follow-up\` (left for later; list it in \`followUps\`) or \`not-checked\` (say why in \`note\`). The board shows it on the closer's card. A Markdown copy to \`${i.markdownPath}\` is optional.`,
    "",
    "## Report format",
    "",
    "```json",
    '{"v":1,"summary":"what you found, two or three sentences",',
    ' "verification":[{"command":"bun test","outcome":"passed|failed|not-run","note":"optional"}],',
    ' "tickets":[{"ticket":"<ticket>","verdict":"ok|fixed|follow-up|not-checked","note":"optional"}],',
    ' "fixes":[{"title":"…","files":["path"],"tickets":["<ticket>"],"commit":"sha"}],',
    ' "followUps":[{"title":"…","detail":"file:line evidence","tickets":["<ticket>"],"severity":"high|medium|low"}],',
    ' "prNotes":"optional: lines the PR description must carry"}',
    "```",
  ];
  const section = (title: string, rows: string[], empty: string, max: number) => {
    out.push("", `## ${title}`, "");
    if (rows.length) out.push(...capped(rows, max));
    else out.push(empty);
  };
  section(`Landed work (${landed.length})`, landed, "Nothing has landed through a mission yet.", MAX_LANDED);
  section(`Tickets to report (${reviewed.length})`, reviewed.length ? [reviewed.map((c) => c.ticket).join(", ")] : [], "None: leave `tickets` empty.", 1);
  section(`Decisions (${decisions.length})`, decisions, "No decisions were recorded.", MAX_DECISIONS);
  section(`Conflict missions (${conflicts.length})`, conflicts, "No landing hit merge conflicts.", MAX_CONFLICTS);
  section("Notes checklist", tasks, "The notes have no checklist.", MAX_TASKS);
  if (recommendations.length) section("Open Intel recommendations", recommendations, "", MAX_RECOMMENDATIONS);
  if (closer.description?.trim()) out.push("", "## Operator notes for this review", "", closer.description.trim());
  out.push("", "## Operation brief", "");
  const brief = i.briefText?.trim() ?? "";
  if (!brief) out.push("The operation has no brief.");
  else if (brief.length > MAX_BRIEF_CHARS) out.push(brief.slice(0, MAX_BRIEF_CHARS), "", `(brief truncated: ${brief.length - MAX_BRIEF_CHARS} more characters in the operation's brief.md)`);
  else out.push(brief);
  return `${out.join("\n")}\n`;
}
