import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UsageTotals } from "../core/types.ts";

export interface PaneUsageSummary {
  tokens: UsageTotals["tokens"];
  costUsd: number | null;
  sessions: number;
  malformedLines: number;
  truncated: boolean;
  /** name:size:mtimeMs of every listed file; a matching cached signature means nothing changed. */
  signature: string;
}

const PER_FILE_CAP = 4 * 1024 * 1024;
const TOTAL_CAP = 8 * 1024 * 1024;
const FILE_CAP = 32;
const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Sum assistant-message usage across every `.jsonl` transcript in a pane's session directory
 * (omp `--session-dir`). Cumulative for the directory: callers emit the delta against the last
 * recorded totals. Budgets bound memory and IO; hitting one reports `truncated`, never throws.
 * A missing or empty directory returns null. `cache` contains only signatures the caller has
 * durably recorded; reading a summary never commits it.
 */
export async function summarizePaneSessions(dir: string, cache?: Map<string, string>): Promise<PaneUsageSummary | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
  const files = names.slice(0, FILE_CAP);
  const signatures = [`files:${names.length}`];
  for (const name of files) {
    try {
      const s = await stat(join(dir, name));
      signatures.push(`${name}:${s.size}:${s.mtimeMs}`);
    } catch {
      signatures.push(`${name}:unreadable`);
    }
  }
  const signature = signatures.join(",");
  if (cache?.get(dir) === signature) return null;
  const out: PaneUsageSummary = {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: null,
    sessions: 0,
    malformedLines: 0,
    truncated: false,
    signature,
  };
  let read = 0;
  if (names.length > FILE_CAP) out.truncated = true;
  for (const name of files) {
    let text: string;
    if (read === TOTAL_CAP) { out.truncated = true; break; }
    try {
      const file = await open(join(dir, name), "r");
      try {
        const size = (await file.stat()).size;
        const limit = Math.min(size, PER_FILE_CAP, TOTAL_CAP - read);
        const buf = Buffer.allocUnsafe(limit);
        let bytes = 0;
        while (bytes < limit) {
          const chunk = await file.read(buf, bytes, limit - bytes, bytes);
          if (!chunk.bytesRead) break;
          bytes += chunk.bytesRead;
        }
        read += bytes;
        out.truncated ||= bytes < size;
        text = buf.toString("utf8", 0, bytes);
      } finally {
        await file.close();
      }
    } catch {
      out.truncated = true;
      out.signature = "";
      continue;
    }
    let sawAssistant = false;
    // The final unterminated record may still be in flight; only complete JSONL records count.
    const complete = text.lastIndexOf("\n");
    for (const line of text.slice(0, complete + 1).split("\n")) {
      if (!line.includes('"assistant"')) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        out.malformedLines++;
        continue;
      }
      if (!record(row) || row.type !== "message" || !record(row.message) || row.message.role !== "assistant") continue;
      const usage = row.message.usage;
      if (!record(usage)) { out.malformedLines++; continue; }
      let bad = false;
      for (const key of TOKEN_KEYS) {
        const value = usage[key];
        if (value === undefined && (key === "cacheRead" || key === "cacheWrite")) continue;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) { bad = true; break; }
      }
      const cost = record(usage.cost) ? usage.cost.total : undefined;
      if (cost !== undefined && (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) bad = true;
      if (bad) { out.malformedLines++; continue; }
      sawAssistant = true;
      for (const key of TOKEN_KEYS) out.tokens[key] += (usage[key] as number | undefined) ?? 0;
      if (typeof cost === "number") out.costUsd = (out.costUsd ?? 0) + cost;
    }
    if (sawAssistant) out.sessions++;
  }
  return out.sessions > 0 || out.malformedLines > 0 || out.truncated ? out : null;
}
