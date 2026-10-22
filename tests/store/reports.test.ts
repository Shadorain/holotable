import { afterEach, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MissionReport } from "../../src/core/types.ts";
import { contactReportPath, readContactReport, saveContactReport } from "../../src/store/reports.ts";
import { removeAll, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

const report = (over: Partial<MissionReport> = {}): MissionReport => ({
  v: 1, at: "2026-01-01T00:05:00.000Z", revision: "r1", summary: "Delivered.",
  work: [{ title: "Make the change", state: "done" }],
  verification: { outcome: "passed", detail: null, revision: "r1" },
  review: { rounds: 1, findings: 2, repaired: 2, rejected: 0, deferred: 0, escalated: 0 },
  followUps: [], delivery: { outcome: "delivered", url: null },
  ...over,
});

test("a saved report reads back; the same report again writes nothing", async () => {
  const home = tempDir("reports", dirs);
  expect(await readContactReport(home, "lab", "CHR-1")).toBeNull();
  expect(await saveContactReport(home, "lab", "CHR-1", report())).toBe(true);
  expect(await readContactReport(home, "lab", "CHR-1")).toEqual(report());
  const written = statSync(contactReportPath(home, "lab", "CHR-1")).mtimeMs;
  expect(await saveContactReport(home, "lab", "CHR-1", report())).toBe(false);
  expect(statSync(contactReportPath(home, "lab", "CHR-1")).mtimeMs).toBe(written);
  expect(await saveContactReport(home, "lab", "CHR-1", report({ summary: "Newer." }))).toBe(true);
  expect((await readContactReport(home, "lab", "CHR-1"))?.summary).toBe("Newer.");
});

test("empty work keeps the saved list of the same revision; a new revision replaces it", async () => {
  const home = tempDir("reports", dirs);
  await saveContactReport(home, "lab", "CHR-1", report());
  await saveContactReport(home, "lab", "CHR-1", report({ work: [], at: "2026-01-01T00:06:00.000Z" }));
  expect(await readContactReport(home, "lab", "CHR-1")).toEqual(report({ at: "2026-01-01T00:06:00.000Z" }));
  await saveContactReport(home, "lab", "CHR-1", report({ work: [], revision: "r2" }));
  expect((await readContactReport(home, "lab", "CHR-1"))?.work).toEqual([]);
});

test("a file that is not a report reads as none and is replaced on the next save", async () => {
  const home = tempDir("reports", dirs);
  const path = contactReportPath(home, "lab", "CHR-1");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{nope");
  expect(await readContactReport(home, "lab", "CHR-1")).toBeNull();
  expect(await saveContactReport(home, "lab", "CHR-1", report({ work: [] }))).toBe(true);
  expect(await readContactReport(home, "lab", "CHR-1")).toEqual(report({ work: [] }));
});
