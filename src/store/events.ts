import { appendFile, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "../core/types.ts";
import { validateEvent } from "../core/validate-event.ts";
import { operationDir } from "../paths.ts";

function eventsFile(home: string, opId: string): string {
  return join(operationDir(home, opId), "events.jsonl");
}

export async function appendEvent(home: string, opId: string, e: Event): Promise<void> {
  const path = eventsFile(home, opId);
  const event = validateEvent(e, path);
  // A crash or full disk can leave a torn final line; drop it before appending
  // so a complete record never glues onto a partial fragment.
  let tornFrom: number | null = null;
  try {
    const existing = await readFile(path, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) {
      const nl = existing.lastIndexOf("\n");
      tornFrom = Buffer.byteLength(nl === -1 ? "" : existing.slice(0, nl + 1), "utf8");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (tornFrom !== null) await truncate(path, tornFrom);
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

/** Parse JSONL events; `path` is only used in error messages. */
export function parseEvents(text: string, path: string): Event[] {
  const lines = text.split("\n");
  const tornLast = lines.at(-1) !== ""; // file did not end in a newline
  if (!tornLast) lines.pop(); // trailing newline of the last record
  const events: Event[] = [];
  for (const [index, line] of lines.entries()) {
    const at = `${path.split("/").pop() ?? "events.jsonl"}:${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      // Ignore an unparsable torn final line; appendEvent repairs the tail.
      if (tornLast && index === lines.length - 1) continue;
      throw new Error(`Invalid event at ${at}: ${String(error)}`);
    }
    try {
      events.push(validateEvent(value, at));
    } catch (error) {
      if (tornLast && index === lines.length - 1) continue;
      throw error;
    }
  }
  return events;
}

export async function readEvents(home: string, opId: string): Promise<Event[]> {
  const path = eventsFile(home, opId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Cannot read events at ${path}: ${String(error)}`);
  }
  return parseEvents(text, path);
}
