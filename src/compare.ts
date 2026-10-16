import { readFile } from "node:fs/promises";
import { compareManifest, parseManifest, type ComparisonResult, type LoadedTrial } from "./core/compare.ts";
import { readArchiveReport } from "./store/archive.ts";

/**
 * Explicit offline comparison: reads the operator's manifest and only the
 * archive keys it names. Never lists archives, writes state, or starts anything.
 */
export async function compareArchives(home: string, manifestPath: string, now: Date): Promise<ComparisonResult> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new Error(`cannot read manifest ${manifestPath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`manifest ${manifestPath} is not valid JSON`);
  }
  const manifest = parseManifest(value);
  const loaded: LoadedTrial[] = [];
  for (const trial of manifest.trials) {
    const entry = await readArchiveReport(home, trial.archive, now);
    if (entry === null) throw new Error(`archive "${trial.archive}" does not exist or has no readable report`);
    loaded.push({ trial, report: entry.report });
  }
  return compareManifest(manifest, loaded);
}
