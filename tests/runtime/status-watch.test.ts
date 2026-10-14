import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchMissionStatuses } from "../../src/runtime/status-watch.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** fs.watch has no readiness signal beyond our sync; burst writes stand in for mission churn. */
async function untilFired(fired: () => boolean, write: () => void): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!fired() && Date.now() < deadline) {
    try {
      write();
    } catch {
      // A retry racing the test's own mkdir is fine; the next burst lands.
    }
    await Bun.sleep(50);
  }
  expect(fired()).toBe(true);
}

test("a status-file write inside missions/<id>/status wakes the callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "holo-watch-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "missions"), { recursive: true });
  let fired = false;
  const watch = watchMissionStatuses(dir, () => {
    fired = true;
  }, 10);
  cleanup.push(() => watch.close());
  await watch.ready;

  await untilFired(
    () => fired,
    () => {
      mkdirSync(join(dir, "missions", "ws", "status"), { recursive: true });
      writeFileSync(join(dir, "missions", "ws", "status", "a.json"), `{"t":${Date.now()}}`, { flag: "w" });
    },
  );
});

test("missing missions root arms later and close stops everything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "holo-watch-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let fired = false;
  const watch = watchMissionStatuses(dir, () => {
    fired = true;
  }, 10);
  cleanup.push(() => watch.close());
  // No missions root yet: the first write races the resync, so keep writing like a mission would.
  mkdirSync(join(dir, "missions", "ws", "status"), { recursive: true });
  await untilFired(
    () => fired,
    () => writeFileSync(join(dir, "missions", "ws", "status", "a.json"), `{"t":${Date.now()}}`),
  );

  watch.close();
  fired = false;
  writeFileSync(join(dir, "missions", "ws", "status", "a.json"), `{"t":${Date.now()}}`);
  await Bun.sleep(100);
  expect(fired).toBe(false);
});
