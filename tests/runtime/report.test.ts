import { afterEach, expect, test } from "bun:test";
import { createBoardService } from "../../src/board.ts";
import type { MissionReport } from "../../src/core/types.ts";
import { createWatcher } from "../../src/runtime/watcher.ts";
import { DEFAULT_SETTINGS } from "../../src/settings.ts";
import { appendEvent } from "../../src/store/events.ts";
import { contact, fakePorts, lane, removeAll, seedOperation, status, tempDir } from "../helpers.ts";

const dirs: string[] = [];
afterEach(() => removeAll(dirs));

const report: MissionReport = {
  v: 1, at: "2026-01-01T00:05:00.000Z", revision: "abc123", summary: "Delivered the change.",
  work: [{ title: "Make the change", state: "done" }],
  verification: { outcome: "passed", detail: null, revision: "abc123" },
  review: { rounds: 1, findings: 2, repaired: 1, rejected: 0, deferred: 1, escalated: 0 },
  followUps: [{ title: "Migrate callers", severity: "low", source: "deferred" }],
  delivery: { outcome: "delivered", url: "https://github.com/o/r/pull/7" },
};

test("a landed, reaped contact still answers its report after the status file and the watcher are gone", async () => {
  const home = tempDir("report", dirs);
  await seedOperation(home, { contacts: [contact("CHR-1", { lane: lane("/wt/a", "t1", "feat/a") })] });
  const fake = fakePorts();
  fake.world.statuses.set("/wt/a", status({ complete: true, phase: "complete", report }));
  const watcherFor = () => createWatcher({
    home, now: () => new Date("2026-01-01T00:10:00Z"), settings: async () => DEFAULT_SETTINGS, portsFor: () => fake.ports, warn: () => undefined,
  });
  const live = watcherFor();
  await live.pass();
  expect(await createBoardService(home, { extras: live.extras }).report("lab", "CHR-1")).toEqual({ ticket: "CHR-1", report });

  await appendEvent(home, "lab", { v: 1, at: "2026-01-01T00:11:00.000Z", kind: "landed", contact: "CHR-1", via: "pr" });
  await appendEvent(home, "lab", { v: 1, at: "2026-01-01T00:11:00.000Z", kind: "reaped", contact: "CHR-1" });
  fake.world.statuses.clear();
  // A restarted board: no status in memory, and the watcher no longer reads landed contacts.
  const restarted = watcherFor();
  await restarted.pass();
  expect(restarted.extras("lab").statuses["CHR-1"]).toBeUndefined();
  expect(await createBoardService(home, { extras: restarted.extras }).report("lab", "CHR-1")).toEqual({ ticket: "CHR-1", report });
});
