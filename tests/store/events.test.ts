import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdir, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "../../src/core/types.ts";
import { foldEvents } from "../../src/core/fold.ts";
import { appendEvent, readEvents, readFolded } from "../../src/store/events.ts";

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

describe("readEvents cache", () => {
  const line = (e: Event) => `${JSON.stringify(e)}\n`;
  const at = (ticket: string): Event => ({ ...queued, contact: ticket });
  async function setup(): Promise<{ home: string; file: string }> {
    const home = tempHome();
    await createDir(home);
    return { home, file: join(home, "operations", "demo", "events.jsonl") };
  }

  test("sees lines another writer appends after a read", async () => {
    const { home, file } = await setup();
    await writeFile(file, line(at("a")));
    expect(await readEvents(home, "demo")).toEqual([at("a")]);
    await appendFile(file, line(at("b")) + line(at("c")));
    expect(await readEvents(home, "demo")).toEqual([at("a"), at("b"), at("c")]);
    await appendEvent(home, "demo", at("d"));
    expect(await readEvents(home, "demo")).toEqual([at("a"), at("b"), at("c"), at("d")]);
  });

  test("a partial trailing line is not final until its newline arrives", async () => {
    const { home, file } = await setup();
    const text = line(at("b"));
    await writeFile(file, line(at("a")) + text.slice(0, 20));
    expect(await readEvents(home, "demo")).toEqual([at("a")]);
    await appendFile(file, text.slice(20, -1));
    // Complete JSON without its newline reads as before the cache: kept, but not final.
    expect(await readEvents(home, "demo")).toEqual([at("a"), at("b")]);
    await appendFile(file, "\n");
    expect(await readEvents(home, "demo")).toEqual([at("a"), at("b")]);
    await appendFile(file, line(at("c")));
    expect(await readEvents(home, "demo")).toEqual([at("a"), at("b"), at("c")]);
  });

  test("a torn tail cut away and replaced is read again", async () => {
    const { home, file } = await setup();
    await writeFile(file, `${line(at("a"))}{"at":"trunc`);
    expect(await readEvents(home, "demo")).toEqual([at("a")]);
    await appendEvent(home, "demo", at("b"));
    expect(await readEvents(home, "demo")).toEqual([at("a"), at("b")]);
  });

  test("truncation and rewrites reparse from the start", async () => {
    const { home, file } = await setup();
    await writeFile(file, line(at("a")) + line(at("b")) + line(at("c")));
    expect(await readEvents(home, "demo")).toHaveLength(3);
    await truncate(file, line(at("a")).length);
    expect(await readEvents(home, "demo")).toEqual([at("a")]);
    // Longer, with different earlier lines: not an append.
    await writeFile(file, line(at("x")) + line(at("y")) + line(at("z")));
    expect(await readEvents(home, "demo")).toEqual([at("x"), at("y"), at("z")]);
  });

  test("a same-size rewrite in the same file-time tick is still seen", async () => {
    const { home, file } = await setup();
    // Whole seconds: both writes end with exactly the same size, inode and mtime.
    const tick = Math.floor(Date.now() / 1000);
    await writeFile(file, line(at("a")) + line(at("b")));
    await utimes(file, tick, tick);
    expect(await readEvents(home, "demo")).toEqual([at("a"), at("b")]);
    await writeFile(file, line(at("c")) + line(at("d")));
    await utimes(file, tick, tick);
    expect(await readEvents(home, "demo")).toEqual([at("c"), at("d")]);
  });

  test("an invalid appended line names its line number in the whole file", async () => {
    const { home, file } = await setup();
    await writeFile(file, line(at("a")) + line(at("b")));
    await readEvents(home, "demo");
    await appendFile(file, `{"broken\n${line(at("c"))}`);
    await expect(readEvents(home, "demo")).rejects.toThrow("Invalid event at events.jsonl:3:");
    await expect(readEvents(home, "demo")).rejects.toThrow("Invalid event at events.jsonl:3:");
  });

  test("concurrent reads and appends each see a prefix of the final log", async () => {
    const { home } = await setup();
    const events = Array.from({ length: 40 }, (_, i) => at(`t-${i}`));
    const reads: Promise<Event[]>[] = [];
    await Promise.all(events.map(async (event) => {
      reads.push(readEvents(home, "demo"));
      await appendEvent(home, "demo", event);
      reads.push(readEvents(home, "demo"));
    }));
    const all = await readEvents(home, "demo");
    expect(all).toEqual(events);
    for (const seen of await Promise.all(reads)) expect(seen).toEqual(all.slice(0, seen.length));
  });

  test("an append made before a read is in that read, and concurrent reads share one parse", async () => {
    const { home } = await setup();
    for (const ticket of ["a", "b", "c"]) {
      await appendEvent(home, "demo", at(ticket));
      const [first, second] = await Promise.all([readEvents(home, "demo"), readEvents(home, "demo")]);
      expect(first.at(-1)).toEqual(at(ticket));
      expect(second).toBe(first);
    }
  });

  test("readFolded folds the current events and refolds only when they change", async () => {
    const { home } = await setup();
    await appendEvent(home, "demo", at("a"));
    const first = await readFolded(home, "demo");
    expect(first.derived).toEqual(foldEvents([at("a")]));
    expect((await readFolded(home, "demo")).derived).toBe(first.derived);
    await appendEvent(home, "demo", { v: 1, at: queued.at, contact: "a", kind: "landed", via: "manual" });
    const next = await readFolded(home, "demo");
    expect(next.derived.contacts.a?.landed).toBe(true);
    expect(next.derived).toEqual(foldEvents(next.events));
  });
});

async function createDir(home: string): Promise<void> {
  await mkdir(join(home, "operations", "demo"), { recursive: true });
}
