import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { check, lock } from "proper-lockfile";

export interface BoardInfo {
  home: string;
  pid: number;
  url: string;
  urls?: string[];
}
export interface BoardLock {
  /** Record the running board for other processes to find. */
  publish(url: string, urls?: string[]): Promise<void>;
  release(): Promise<void>;
}
export type BoardAcquire =
  | { ok: true; lock: BoardLock }
  | { ok: false; owner: BoardInfo | null };

const target = (home: string) => join(home, "board.lock");
const info = (home: string) => join(home, "board.json");

export async function readBoardInfo(home: string): Promise<BoardInfo | null> {
  try {
    const value: unknown = JSON.parse(await readFile(info(home), "utf8"));
    if (typeof value !== "object" || value === null || !("home" in value) || !("pid" in value) || !("url" in value))
      return null;
    // Discovery is bound to this home: copied board.json/token can never take over another home's board.
    if (typeof value.home !== "string" || value.home !== await realpath(home) || typeof value.pid !== "number" || typeof value.url !== "string")
      return null;
    const urls = "urls" in value && Array.isArray(value.urls) && value.urls.every((u: unknown) => typeof u === "string")
      ? value.urls : [value.url];
    return { home: value.home, pid: value.pid, url: value.url, urls };
  } catch {
    return null;
  }
}

export async function boardIsLocked(home: string): Promise<boolean> {
  try {
    return await check(target(home), { realpath: false, stale: 30_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** One board per home. `onCompromised` fires when the lock is lost (suspend, disk stall) and the board must stop. */
export async function acquireBoard(home: string, onCompromised: (error: Error) => void): Promise<BoardAcquire> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await (await open(target(home), "wx", 0o600)).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let release: () => Promise<void>;
  try {
    release = await lock(target(home), { realpath: false, stale: 30_000, update: 10_000, retries: 0, onCompromised });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return { ok: false, owner: await readBoardInfo(home) };
    throw error;
  }
  return {
    ok: true,
    lock: {
      async publish(url, urls = [url]) {
        await writeFile(info(home), `${JSON.stringify({ home: await realpath(home), pid: process.pid, url, urls })}\n`, { mode: 0o600 });
      },
      async release() {
        await rm(info(home), { force: true });
        await release();
      },
    },
  };
}

// ---- board token ----
// The URL fragment is the API key. It lives in its own file (not in board.json, which disappears with
// the process) so the same URL keeps working across service restarts.

const tokenFile = (home: string) => join(home, "token");

/** The persisted board token, creating it on first use. */
export async function ensureToken(home: string): Promise<string> {
  const existing = await readToken(home);
  if (existing) return existing;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const tmp = `${tokenFile(home)}.tmp-${process.pid}`;
  await writeFile(tmp, `${token}\n`, { mode: 0o600 });
  await rename(tmp, tokenFile(home));
  return token;
}

export async function readToken(home: string): Promise<string | null> {
  try {
    const value = (await readFile(tokenFile(home), "utf8")).trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

// ---- selection ----
// The operator's selected operation, shared by the CLI across invocations. OMP sessions keep their
// own per-session selection instead.

const selectionFile = (home: string) => join(home, "current");

export async function readSelection(home: string): Promise<string | null> {
  try {
    const id = (await readFile(selectionFile(home), "utf8")).trim();
    return /^[a-z0-9][a-z0-9-]{0,47}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export async function writeSelection(home: string, id: string | null): Promise<void> {
  if (id === null) {
    await rm(selectionFile(home), { force: true });
    return;
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(selectionFile(home), `${id}\n`, { mode: 0o600 });
}
