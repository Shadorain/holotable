import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { operationDir } from "../paths.ts";
import { writeFileAtomic } from "./atomic.ts";

const MAX_BRIEF = 256 * 1024;
const MAX_SEED = 1024 * 1024;

function briefFile(home: string, id: string): string {
  return join(operationDir(home, id), "brief.md");
}

function seedFile(home: string, id: string): string {
  return join(operationDir(home, id), "seed.json");
}

export async function readBrief(home: string, id: string): Promise<{ brief: string | null; seed: { text: string } | null }> {
  const bpath = briefFile(home, id);
  const spath = seedFile(home, id);
  let brief: string | null = null;
  try {
    brief = await readFile(bpath, "utf8");
    if (Buffer.byteLength(brief) > MAX_BRIEF) brief = brief.slice(0, MAX_BRIEF);
  } catch {
    brief = null;
  }
  let seed: { text: string } | null = null;
  try {
    const s = await readFile(spath, "utf8");
    seed = { text: s };
  } catch {
    seed = null;
  }
  return { brief, seed };
}

export async function writeBrief(home: string, id: string, text: string): Promise<void> {
  const buf = Buffer.from(text, "utf8");
  if (buf.length > MAX_BRIEF) throw new Error("brief exceeds 256 KiB");
  await writeFileAtomic(briefFile(home, id), text);
}
export async function writeSeed(home: string, id: string, text: string): Promise<void> {
  const dir = operationDir(home, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const spath = seedFile(home, id);
  const buf = Buffer.from(text, "utf8");
  if (buf.length > MAX_SEED) throw new Error("seed exceeds 1 MiB");
  // write once semantics: do not overwrite if exists
  try {
    await writeFile(spath, text, { mode: 0o600, flag: "wx" });
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e) {
      // after 'in' guard the property is present as unknown; compare directly
      if ((e as Record<string, unknown>).code === "EEXIST") return;
    }
    throw e;
  }
}

export async function seedBriefFromJson(home: string, id: string, seedText: string): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(seedText);
    if (parsed && typeof parsed === "object" && "brief" in parsed) {
      // after guard, index access; assign to named for the cast reason: JSON shape after 'in'
      const rec = parsed as Record<string, unknown>;
      if (typeof rec.brief === "string") {
        await writeBrief(home, id, rec.brief);
      }
    }
  } catch {
    // ignore bad seed
  }
}
