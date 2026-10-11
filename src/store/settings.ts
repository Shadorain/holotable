import { mkdir, readFile } from "node:fs/promises";
import { lock } from "proper-lockfile";
import type { Settings } from "../core/types.ts";
import { DEFAULT_SETTINGS, settingsFile, validateSettings } from "../settings.ts";
import { writeFileAtomic } from "./atomic.ts";

const LOCK_OPTS = { realpath: false, stale: 10_000, retries: { retries: 5, minTimeout: 50 } } as const;

export async function readSettings(home: string): Promise<Settings> {
  const path = settingsFile(home);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        ...DEFAULT_SETTINGS,
        worktrees: { ...DEFAULT_SETTINGS.worktrees },
        defaults: { ...DEFAULT_SETTINGS.defaults },
      };
    throw new Error(`Cannot read settings at ${path}: ${String(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in settings at ${path}: ${String(error)}`);
  }
  return validateSettings(value, path);
}

/** Atomic write under the settings lock. `settings` is re-validated before writing. */
export async function writeSettings(home: string, settings: Settings): Promise<void> {
  const path = settingsFile(home);
  const valid = validateSettings(settings, path);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const release = await lock(path, LOCK_OPTS);
  try {
    await writeFileAtomic(path, `${JSON.stringify(valid, null, 2)}\n`);
  } finally {
    await release();
  }
}

/** Locked read-modify-write so concurrent writers (board API, CLI) don't lose updates. */
export async function mutateSettings(home: string, fn: (current: Settings) => Settings): Promise<Settings> {
  const path = settingsFile(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const release = await lock(path, LOCK_OPTS);
  try {
    const next = validateSettings(fn(await readSettings(home)), path);
    await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  } finally {
    await release();
  }
}
