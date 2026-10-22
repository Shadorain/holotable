import { appendFile, open, truncate, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { foldEvents } from "../core/fold.ts";
import type { Derived, Event } from "../core/types.ts";
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

/** Validate JSONL lines numbered from `firstLine + 1`; a `torn` final line that does not parse is skipped. */
function parseLines(lines: string[], path: string, firstLine: number, torn: boolean): Event[] {
  const name = path.split("/").pop() ?? "events.jsonl";
  const events: Event[] = [];
  for (const [index, line] of lines.entries()) {
    const at = `${name}:${firstLine + index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      // Ignore an unparsable torn final line; appendEvent repairs the tail.
      if (torn && index === lines.length - 1) continue;
      throw new Error(`Invalid event at ${at}: ${String(error)}`);
    }
    try {
      events.push(validateEvent(value, at));
    } catch (error) {
      if (torn && index === lines.length - 1) continue;
      throw error;
    }
  }
  return events;
}

/** Parse JSONL events; `path` is only used in error messages. */
export function parseEvents(text: string, path: string): Event[] {
  const lines = text.split("\n");
  const torn = lines.at(-1) !== ""; // file did not end in a newline
  if (!torn) lines.pop(); // trailing newline of the last record
  return parseLines(lines, path, 0, torn);
}

/** Bytes kept from just before a snapshot's `offset`: an append leaves them in place, a rewrite does not. */
const EDGE_BYTES = 4096;
/** File times move in coarse ticks: a write this close to a stat can leave size and mtime as they were. */
const RACY_MS = 2000;

interface FileStamp {
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  /** Wall clock right after the stat. */
  statAt: number;
}

/**
 * One events.jsonl as of one read. Replaced, never mutated, when the file changes: readers share
 * `events` (frozen) and `derived`, so the watcher, auto, recovery and the board parse and fold a
 * multi-megabyte log once per change instead of once per caller per pass.
 */
interface Snapshot extends FileStamp {
  /** Bytes read; differs from the stat size when the file moved between stat and read. */
  size: number;
  /** End of the last newline-terminated line: only those lines are final, a torn tail is re-read. */
  offset: number;
  /** Newline-terminated lines before `offset`, for error line numbers. */
  lines: number;
  /** Up to EDGE_BYTES ending at `offset`. */
  edge: Buffer;
  /** The torn bytes from `offset` to `size`, usually none. */
  tail: Buffer;
  complete: readonly Event[];
  /** `complete` plus a parseable torn tail. */
  events: Event[];
  derived?: Derived;
}

type Parsed = Pick<Snapshot, "offset" | "lines" | "edge" | "complete">;
const EMPTY: Parsed = { offset: 0, lines: 0, edge: Buffer.alloc(0), complete: Object.freeze([]) };
const snapshots = new Map<string, Snapshot>();
const reads = new Map<string, Promise<Snapshot | null>>();

async function readAt(file: FileHandle, from: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, from + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/** `base` plus the file's bytes from `base.offset` on (`chunk`). Only newline-terminated lines become final. */
function extend(path: string, base: Parsed, chunk: Buffer, stamp: FileStamp): Snapshot {
  const end = chunk.lastIndexOf(0x0a) + 1;
  const lines = end ? chunk.toString("utf8", 0, end).split("\n") : [];
  lines.pop();
  const added = parseLines(lines, path, base.lines, false);
  const complete = added.length ? Object.freeze(base.complete.concat(added)) : base.complete;
  const tailText = chunk.toString("utf8", end);
  const tail = tailText ? parseLines([tailText], path, base.lines + lines.length, true) : [];
  const edge = end >= EDGE_BYTES ? Buffer.from(chunk.subarray(end - EDGE_BYTES, end)) : Buffer.concat([base.edge, chunk.subarray(0, end)]);
  return {
    ...stamp,
    size: base.offset + chunk.length,
    offset: base.offset + end,
    lines: base.lines + lines.length,
    edge: edge.length > EDGE_BYTES ? edge.subarray(edge.length - EDGE_BYTES) : edge,
    tail: Buffer.from(chunk.subarray(end)),
    complete,
    events: (tail.length ? Object.freeze(complete.concat(tail)) : complete) as Event[],
  };
}

async function load(path: string): Promise<Snapshot | null> {
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch (error) {
    snapshots.delete(path);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read events at ${path}: ${String(error)}`);
  }
  try {
    const { dev, ino, mtimeNs, size: statSize } = await file.stat({ bigint: true });
    const stamp: FileStamp = { dev, ino, mtimeNs, statAt: Date.now() };
    const size = Number(statSize);
    const prev = snapshots.get(path);
    const sameFile = prev !== undefined && prev.dev === dev && prev.ino === ino;
    const settled = sameFile && Number(prev.mtimeNs / 1_000_000n) < prev.statAt - RACY_MS;
    if (settled && prev.size === size && prev.mtimeNs === mtimeNs) return prev;
    let next: Snapshot | null = null;
    // Append-only: parse past the last complete line, unless the bytes before it changed (a rewrite).
    if (sameFile && size >= prev.offset) {
      const from = prev.offset - prev.edge.length;
      const bytes = await readAt(file, from, size - from);
      const chunk = bytes.subarray(prev.edge.length);
      if (bytes.subarray(0, prev.edge.length).equals(prev.edge))
        next = chunk.equals(prev.tail) ? { ...prev, ...stamp } : extend(path, prev, chunk, stamp);
    }
    next ??= extend(path, EMPTY, await readAt(file, 0, size), stamp);
    snapshots.set(path, next);
    return next;
  } catch (error) {
    snapshots.delete(path);
    throw error;
  } finally {
    await file.close();
  }
}

/** Reads of one file queue behind each other, so concurrent callers of a changed file share one parse. */
function snapshot(path: string): Promise<Snapshot | null> {
  const next = (reads.get(path) ?? Promise.resolve(null)).catch(() => null).then(() => load(path));
  reads.set(path, next);
  const settled = () => {
    if (reads.get(path) === next) reads.delete(path);
  };
  next.then(settled, settled);
  return next;
}

/** The operation's events, oldest first. The array is shared and frozen: copy before reordering. */
export async function readEvents(home: string, opId: string): Promise<Event[]> {
  return (await snapshot(eventsFile(home, opId)))?.events ?? [];
}

/** The events and their fold, both shared until the file changes: callers must not mutate either. */
export async function readFolded(home: string, opId: string): Promise<{ events: Event[]; derived: Derived }> {
  const snap = await snapshot(eventsFile(home, opId));
  if (!snap) return { events: [], derived: foldEvents([]) };
  snap.derived ??= foldEvents(snap.events);
  return { events: snap.events, derived: snap.derived };
}

/** Drop the cached parse of an operation whose directory moved away (archived). */
export function forgetEvents(home: string, opId: string): void {
  snapshots.delete(eventsFile(home, opId));
}
