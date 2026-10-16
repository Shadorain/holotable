import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "../../src/core/types.ts";
import { appendEvent, readEvents } from "../../src/store/events.ts";

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "holotable-events-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const queued: Event = {
  v: 1,
  at: "2026-10-09T00:00:00.000Z",
  contact: "alpha",
  kind: "queued",
};

describe("appendEvent/readEvents", () => {
  test("missing file reads as empty", async () => {
    expect(await readEvents(tempHome(), "demo")).toEqual([]);
  });

  test("appends one JSON line per event in order", async () => {
    const home = tempHome();
    await createDir(home);
    await appendEvent(home, "demo", queued);
    await appendEvent(home, "demo", { ...queued, kind: "blocked", by: ["beta"] });
    const text = await Bun.file(join(home, "operations", "demo", "events.jsonl")).text();
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    const events = await readEvents(home, "demo");
    expect(events[0].kind).toBe("queued");
    expect(events[1].kind).toBe("blocked");
  });

  test("append rejects an invalid event and writes nothing", async () => {
    const home = tempHome();
    await createDir(home);
    await expect(
      appendEvent(home, "demo", { v: 1, at: "2026-10-09T00:00:00.000Z", kind: "bogus" } as unknown as Event),
    ).rejects.toThrow("Invalid event at");
    expect(await readEvents(home, "demo")).toEqual([]);
  });

  test("readEvents names the bad line number", async () => {
    const home = tempHome();
    await createDir(home);
    const file = join(home, "operations", "demo", "events.jsonl");
    await Bun.write(file, `${JSON.stringify(queued)}\n{"broken\n${JSON.stringify(queued)}\n`);
    await expect(readEvents(home, "demo")).rejects.toThrow("Invalid event at events.jsonl:2:");
  });

  test("readEvents rejects a schema-invalid line with its line number", async () => {
    const home = tempHome();
    await createDir(home);
    const file = join(home, "operations", "demo", "events.jsonl");
    await Bun.write(file, `${JSON.stringify({ v: 1, at: "2025-01-01T00:00:00.000Z", kind: "closed", outcome: "nope" })}\n`);
    await expect(readEvents(home, "demo")).rejects.toThrow("Invalid event at events.jsonl:1: outcome must be one of");
  });

  test("readEvents ignores an unparsable torn final line", async () => {
    const home = tempHome();
    await createDir(home);
    const file = join(home, "operations", "demo", "events.jsonl");
    await Bun.write(file, `${JSON.stringify(queued)}\n{"at":"trunc`);
    expect(await readEvents(home, "demo")).toEqual([queued]);
  });

  test("appendEvent repairs a torn final line before writing", async () => {
    const home = tempHome();
    await createDir(home);
    const file = join(home, "operations", "demo", "events.jsonl");
    await Bun.write(file, `${JSON.stringify(queued)}\n{"at":"trunc`);
    await appendEvent(home, "demo", queued);
    expect(await readEvents(home, "demo")).toEqual([queued, queued]);
  });
  test("concurrent appends preserve every event while repairing a multibyte tail", async () => {
    const home = tempHome();
    await createDir(home);
    const file = join(home, "operations", "demo", "events.jsonl");
    await Bun.write(file, `${JSON.stringify(queued)}\n${"é".repeat(110_000)}`);
    const events = Array.from({ length: 100 }, (_, i): Event => ({ ...queued, contact: `ticket-${i}` }));
    await Promise.all(events.map((event) => appendEvent(home, "demo", event)));
    expect(await readEvents(home, "demo")).toEqual([queued, ...events]);
  });

  test("a parseable tail without newline is discarded before appending", async () => {
    const home = tempHome();
    await createDir(home);
    await Bun.write(join(home, "operations", "demo", "events.jsonl"), JSON.stringify(queued));
    const next: Event = { ...queued, contact: "next" };
    await appendEvent(home, "demo", next);
    expect(await readEvents(home, "demo")).toEqual([next]);
  });

  test("an append failure does not poison later requests for the same path", async () => {
    const home = tempHome();
    await expect(appendEvent(home, "demo", queued)).rejects.toThrow();
    await createDir(home);
    await appendEvent(home, "demo", queued);
    expect(await readEvents(home, "demo")).toEqual([queued]);
  });
});

async function createDir(home: string): Promise<void> {
  await mkdir(join(home, "operations", "demo"), { recursive: true });
}
