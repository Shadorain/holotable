import { expect, test } from "bun:test";
import { MAX_PR_BODY_CHARS, prBody } from "../../src/core/pr-body.ts";
import { parseCloserReview } from "../../src/core/closer.ts";
import type { CloserReview, MissionReport } from "../../src/core/types.ts";

const operation = { base: "v2/backend-rewrite" };
const closer = { ticket: "CLOSER", kind: "closer" as const, description: null };
const review: CloserReview = {
  v: 1,
  summary: "Base passes; one duplicate helper removed.",
  verification: [],
  tickets: [],
  fixes: [{ title: "Kept one retryDelay helper", files: ["src/net/retry.ts"], commit: "3f2c1ab" }],
  followUps: [{ title: "Rewrite docs/socket.md" }],
  prNotes: "Guardrail-change: raised the CI timeout\nSecond line",
};
const report = { summary: "Audit found stale callers.", followUps: [{ title: "Migrate src/legacy.ts", severity: null, source: "deferred" }] } as unknown as MissionReport;

test("a closer review supplies prNotes verbatim, the summary, fixes and follow-ups", () => {
  const body = prBody({ operation, contact: closer, review, report: null });
  expect(body).toContain(review.prNotes!);
  expect(body).toContain(review.summary);
  expect(body).toContain("Kept one retryDelay helper");
  expect(body).toContain("src/net/retry.ts");
  expect(body).toContain("3f2c1ab");
  expect(body).toContain("Rewrite docs/socket.md");
});

test("without a review the mission report's summary and follow-ups are used", () => {
  const body = prBody({ operation, contact: { ticket: "A-1", kind: "audit", description: null }, review: null, report });
  expect(body).toContain("Audit found stale callers.");
  expect(body).toContain("Migrate src/legacy.ts");
});

test("with neither, the body still names the ticket and base", () => {
  const body = prBody({ operation, contact: { ticket: "A-1", kind: "audit", description: "Check callers" }, review: null, report: null });
  expect(body).toContain("A-1");
  expect(body).toContain("v2/backend-rewrite");
  expect(body).toContain("Check callers");
});

test("the body is bounded and keeps prNotes when the rest is huge", () => {
  const big = { ...review, summary: "x".repeat(20_000), fixes: Array.from({ length: 200 }, (_, i) => ({ title: `fix ${i} ${"y".repeat(200)}` })) };
  const body = prBody({ operation, contact: closer, review: big, report: null });
  expect(body.length).toBeLessThanOrEqual(MAX_PR_BODY_CHARS);
  expect(body).toContain(review.prNotes!);
});

test("parseCloserReview keeps prNotes, clips oversize ones and drops bad ones without rejecting", () => {
  const base = { v: 1, summary: "s" };
  expect(parseCloserReview({ ...base, prNotes: "Guardrail-change: x" })?.prNotes).toBe("Guardrail-change: x");
  expect(parseCloserReview({ ...base, prNotes: "z".repeat(5000) })?.prNotes?.length).toBe(2000);
  const bad = parseCloserReview({ ...base, prNotes: 42 });
  expect(bad).not.toBeNull();
  expect(bad && "prNotes" in bad).toBe(false);
});
