import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

const OVERLAYS = {
  // A fresh mission: plan mode lets the autostarted `/mission` create a pending plan.
  plan: { file: "plan-default.yml", text: "plan:\n  defaultOnStartup: true\n" },
  // A saved mission being resumed: omp-mission refuses to continue (a mutation) while the session is in plan mode.
  resume: { file: "resume.yml", text: "plan:\n  defaultOnStartup: false\n" },
} as const;

/**
 * The `--config` overlay a launched session gets. Rewritten when absent or different so a hand edit cannot
 * weaken it.
 */
export async function ensureLaunchOverlay(home: string, kind: keyof typeof OVERLAYS = "plan"): Promise<string> {
  const { file, text } = OVERLAYS[kind];
  const dir = join(home, "launch");
  const path = join(dir, file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const current = await readFile(path, "utf8").catch(() => null);
  if (current !== text) {
    await writeFileAtomic(path, text);
  }
  return path;
}
