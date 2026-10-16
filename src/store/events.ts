import { appendFile, open, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "../core/types.ts";
import { notifyChanged } from "../core/notify.ts";
import { validateEvent } from "../core/validate-event.ts";
import { operationDir } from "../paths.ts";

function eventsFile(home: string, opId: string): string {
  return join(operationDir(home, opId), "events.jsonl");
}

const pending = new Map<string, Promise<void>>();

async function repairTail(path: string): Promise<void> {
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let tornFrom: number | null = null;
  try {
    const { size } = await file.stat();
    if (size === 0) return;
    const last = Buffer.allocUnsafe(1);
    const end = await file.read(last, 0, 1, size - 1);
    if (end.bytesRead !== 1) throw new Error(`Cannot read event tail at ${path}`);
    if (last[0] === 0x0a) return;
    const buffer = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
    let offset = size;
    tornFrom = 0;
    while (offset > 0) {
      const length = Math.min(offset, buffer.length);
      offset -= length;
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error(`Cannot read event tail at ${path}`);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (newline !== -1) {
        tornFrom = offset + newline + 1;
        break;
      }
    }
  } finally {
    await file.close();
  }
  if (tornFrom !== null) await truncate(path, tornFrom);
}

export async function appendEvent(home: string, opId: string, e: Event): Promise<void> {
  const path = eventsFile(home, opId);
  const event = validateEvent(e, path);
  const next = (pending.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await repairTail(path);
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
    notifyChanged();
  });
  pending.set(path, next);
  try {
    await next;
  } finally {
    if (pending.get(path) === next) pending.delete(path);
  }
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
