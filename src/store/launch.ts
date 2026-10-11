import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

const OVERLAY = "plan:\n  defaultOnStartup: true\n";

/**
 * The `--config` overlay that opens a launched session in plan mode, which is what lets the autostarted
 * `/mission` create a pending plan. Rewritten when absent or different so a hand edit cannot weaken it.
 */
export async function ensureLaunchOverlay(home: string): Promise<string> {
  const dir = join(home, "launch");
  const path = join(dir, "plan-default.yml");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const current = await readFile(path, "utf8").catch(() => null);
  if (current !== OVERLAY) {
    await writeFileAtomic(path, OVERLAY);
  }
  return path;
}
