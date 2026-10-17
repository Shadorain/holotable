import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { summarizePaneSessions } from "../../src/store/pane-usage.ts";
import { readDraftUsage } from "../../src/store/drafts.ts";
import { removeAll, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));
const message = JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 100, output: 10, cost: { total: 0.01 } } } });

test("an in-flight JSONL tail is neither charged nor malformed, and reads do not commit the cache", async () => {
  const dir = tempDir("pane-tail", dirs), file = join(dir, "one.jsonl"), cache = new Map<string, string>();
  const split = message.length - 4;
  await writeFile(file, message + "\n" + message.slice(0, split));
  const first = (await summarizePaneSessions(dir, cache))!;
  expect(first.tokens.input).toBe(100);
  expect(first.malformedLines).toBe(0);
  expect((await summarizePaneSessions(dir, cache))?.tokens.input).toBe(100);
  cache.set(dir, first.signature);
  expect(await summarizePaneSessions(dir, cache)).toBeNull();
  await appendFile(file, message.slice(split) + "\n");
  const completed = (await summarizePaneSessions(dir, cache))!;
  expect(completed.tokens.input).toBe(200);
  expect(completed.malformedLines).toBe(0);
});

test("read caps report partial evidence without parsing a clipped record as corrupt", async () => {
  const dir = tempDir("pane-cap", dirs);
  await writeFile(join(dir, "large.jsonl"), message + "\n" + message.slice(0, -2) + " ".repeat(5 * 1024 * 1024));
  const result = (await summarizePaneSessions(dir))!;
  expect(result.tokens.input).toBe(100);
  expect(result.truncated).toBe(true);
  expect(result.malformedLines).toBe(0);
});

test("draft ledger ignores invalid counts, deduplicates retries and retains partial coverage", async () => {
  const home = tempDir("draft-ledger", dirs);
  await mkdir(join(home, "drafts"));
  const row = { v: 1, id: "draft-deadbeef", tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.2, sessions: 1, truncated: true };
  await writeFile(join(home, "drafts", "usage.jsonl"), [row, row, { ...row, id: "draft-12345678", tokens: { ...row.tokens, input: -10 } }, { ...row, id: "draft-87654321", costUsd: -3 }].map(r => JSON.stringify(r)).join("\n") + "\n");
  expect(await readDraftUsage(home)).toEqual({ tokens: 110, costUsd: 0.2, sessions: 1, partial: true });
});
