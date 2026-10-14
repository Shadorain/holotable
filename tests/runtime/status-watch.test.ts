import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchMissionStatuses } from "../../src/runtime/status-watch.ts";

test("writing a mission status wakes the board after watcher readiness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "holo-watch-"));
  const statusDir = join(dir, "missions", "workspace", "status");
  mkdirSync(statusDir, { recursive: true });
  const changed = Promise.withResolvers<string>();
  const watcher = watchMissionStatuses(dir, () => {
    changed.resolve(JSON.parse(readFileSync(join(statusDir, "mission.json"), "utf8")).phase);
  }, 0);
  try {
    await watcher.ready;
    writeFileSync(join(statusDir, "mission.json"), '{"phase":"execute"}');
    expect(await changed.promise).toBe("execute");
  } finally {
    watcher.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
