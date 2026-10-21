import { join } from "node:path";
import { assertDraftId, draftDir } from "../paths.ts";

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
