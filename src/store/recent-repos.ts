import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

const MAX_RECENT = 5;

/** Read recently used repos from <home>/recent-repos.json; returns empty array on missing or corrupt file. */
export async function readRecentRepos(home: string): Promise<string[]> {
  try {
    const raw = await readFile(join(home, "recent-repos.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string" && p.length > 0);
  } catch {
    return [];
  }
}

/** Prepend a repo path to <home>/recent-repos.json, deduplicating by realpath and capping at 5 entries. */
export async function recordRecentRepo(home: string, repo: string): Promise<void> {
  if (!repo || typeof repo !== "string") return;
  const target = repo.trim();
  if (!target) return;

  const current = await readRecentRepos(home);
  const targetReal = await realpath(target).catch(() => target);

  const filtered: string[] = [];
  for (const p of current) {
    const real = await realpath(p).catch(() => p);
    if (real !== targetReal && p !== target) {
      filtered.push(p);
    }
  }

  const updated = [target, ...filtered].slice(0, MAX_RECENT);
  await writeFileAtomic(join(home, "recent-repos.json"), `${JSON.stringify(updated, null, 2)}\n`);
}
