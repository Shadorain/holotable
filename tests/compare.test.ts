import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareArchives } from "../src/compare.ts";
import type { CompareManifest, ComparisonResult, ManifestTrial } from "../src/core/compare.ts";
import { archiveDir } from "../src/paths.ts";
import { evaluation, removeAll, reportFixture, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

const REPO = "/repo";
const trial = (group: "A" | "B", pair: string): ManifestTrial => ({
  archive: `arc-${pair}-${group}`, group, pair, repo: REPO, baseCommit: "c".repeat(40),
  workload: "fixture-v1", acceptance: "smoke-v1", environment: "host-v1", externalOutcome: "unassessed",
});

function seedArchive(home: string, key: string, group: "A" | "B"): void {
  const e = evaluation({
    deliveredWork: 2,
    delivery: { n: 2, medianMs: group === "A" ? 100 : 80, p90Ms: null },
    config: { value: { graph: "beads", frontend: "subagent", maxWorkers: group === "A" ? 1 : 2, reviewConcurrency: 1, mode: "auto" }, mixed: false },
  });
  const dir = join(archiveDir(home), key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), JSON.stringify(reportFixture({ evaluation: e })));
}

async function run(manifest: unknown): Promise<ComparisonResult> {
  const home = tempDir("compare", dirs);
  for (const t of (manifest as CompareManifest).trials) seedArchive(home, t.archive, t.group);
  const file = join(home, "manifest.json");
  writeFileSync(file, JSON.stringify(manifest));
  return compareArchives(home, file, new Date());
}

const fivePairs = Array.from({ length: 5 }, (_, i) => [trial("A", `w${i + 1}`), trial("B", `w${i + 1}`)]).flat();
const manifest = (trials: ManifestTrial[]): CompareManifest => ({ v: 1, variable: "maxWorkers", baseline: "A", groups: { A: 1, B: 2 }, trials });

describe("compareArchives", () => {
  test("loads only named archive keys and evaluates real persisted reports", async () => {
    const r = await run(manifest(fivePairs));
    expect(r.comparable).toBe(true);
    expect(r.pairs).toBe(5);
    expect(r.differences?.deliveryMs.median).toBe(-20);
    expect(r.groups.A.trials).toBe(5);
  });

  test("missing archive is an error, not a skipped trial", async () => {
    const home = tempDir("compare", dirs);
    const file = join(home, "manifest.json");
    writeFileSync(file, JSON.stringify(manifest(fivePairs)));
    await expect(compareArchives(home, file, new Date())).rejects.toThrow('archive "arc-w1-A" does not exist');
  });

  test("traversal key cannot escape the archive directory", async () => {
    const home = tempDir("compare", dirs);
    const t = { ...trial("A", "w1"), archive: "../../secret", pair: "w0" };
    const file = join(home, "manifest.json");
    writeFileSync(file, JSON.stringify(manifest([t, ...fivePairs])));
    await expect(compareArchives(home, file, new Date())).rejects.toThrow('archive "../../secret" does not exist');
  });

  test("unreadable and invalid manifests fail before any archive access", async () => {
    const home = tempDir("compare", dirs);
    await expect(compareArchives(home, join(home, "none.json"), new Date())).rejects.toThrow("cannot read manifest");
    const bad = join(home, "bad.json");
    writeFileSync(bad, "{nope");
    await expect(compareArchives(home, bad, new Date())).rejects.toThrow("not valid JSON");
    const wrong = join(home, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ v: 2 }));
    await expect(compareArchives(home, wrong, new Date())).rejects.toThrow("v 1");
  });

  test("an archive whose stored evaluation is invalid degrades to missing evidence, not a crash", async () => {
    const home = tempDir("compare", dirs);
    for (const t of fivePairs) seedArchive(home, t.archive, t.group);
    const broken = join(archiveDir(home), "arc-w1-A", "report.json");
    const stored = JSON.parse(await Bun.file(broken).text());
    stored.evaluation = { v: 1, bogus: true };
    writeFileSync(broken, JSON.stringify(stored));
    const file = join(home, "manifest.json");
    writeFileSync(file, JSON.stringify(manifest(fivePairs)));
    const r = await compareArchives(home, file, new Date());
    expect(r.comparable).toBe(false);
    expect(r.reasons.join("\n")).toContain("pair w1: group A archive has no v1 evaluation");
    expect(r.groups.A.missingEvaluationTrials).toBe(1);
  });
});
