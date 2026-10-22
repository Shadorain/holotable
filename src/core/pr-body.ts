import type { CloserReview, Contact, MissionReport, Operation } from "./types.ts";

/** Far under GitHub's 65536-character limit: the body is a summary, the closer's card holds the rest. */
export const MAX_PR_BODY_CHARS = 8000;
const MAX_ROWS = 20;

export interface PrBodyInput {
  operation: Pick<Operation, "base">;
  contact: Pick<Contact, "ticket" | "kind" | "description">;
  /** The closer's JSON review, when it wrote one. */
  review: CloserReview | null;
  /** The mission's persisted report, used when there is no review. */
  report: MissionReport | null;
}

function list(title: string, rows: string[]): string[] {
  if (!rows.length) return [];
  const shown = rows.slice(0, MAX_ROWS);
  if (rows.length > MAX_ROWS) shown.push(`- … and ${rows.length - MAX_ROWS} more`);
  return ["", `## ${title}`, "", ...shown];
}

function reviewSections(review: CloserReview): string[] {
  const fixes = review.fixes.map((f) => {
    const files = f.files?.length ? ` (${f.files.join(", ")})` : "";
    const commit = f.commit ? ` — ${f.commit}` : "";
    return `- ${f.title}${files}${commit}`;
  });
  const followUps = review.followUps.map((f) => `- ${f.title}${f.detail ? `: ${f.detail}` : ""}`);
  return [review.summary.trim(), ...list("Fixes", fixes), ...list("Follow-ups", followUps)];
}

function reportSections(report: MissionReport): string[] {
  const followUps = report.followUps.map((f) => `- ${f.title}`);
  return [report.summary?.trim() ?? "", ...list("Follow-ups", followUps)];
}

/**
 * The description of a PR the board opens for an audit or closer that committed work and delivered none:
 * the closer's review (its `prNotes` verbatim, so repo policy markers survive) or the mission's report,
 * else a generic line. Bounded; `prNotes` is placed first so truncation never cuts it.
 */
export function prBody(i: PrBodyInput): string {
  const { contact, operation, review, report } = i;
  const parts: string[] = [];
  const notes = review?.prNotes?.trim();
  if (notes) parts.push(notes, "");
  const description = contact.description?.trim();
  if (description) parts.push(description, "");
  let content: string[] = [];
  if (review) content = reviewSections(review);
  else if (report?.summary?.trim()) content = reportSections(report);
  if (content.length) parts.push(...content, "");
  parts.push(`Opened by holotable: the ${contact.kind} mission for ${contact.ticket} finished with commits that are not in \`${operation.base}\` and delivered no PR.`);
  const body = parts.join("\n").trim();
  if (body.length <= MAX_PR_BODY_CHARS) return body;
  return `${body.slice(0, MAX_PR_BODY_CHARS - 20).trimEnd()}\n\n(body truncated)`;
}
