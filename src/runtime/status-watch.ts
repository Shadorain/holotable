import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const RESYNC_MS = 10_000;

export interface StatusWatch {
  /** Resolves when the first directory sync has armed the watchers. */
  ready: Promise<void>;
  close(): void;
}

/**
 * fs.watch over <agentDir>/missions and every missions/<id>/status directory.
 * Any write inside wakes the callback after a short debounce, so mission status
 * changes reach the watcher in under a second instead of on the next poll tick.
 * Watchers die silently (directory deleted, inotify limit), so a slow resync
 * re-arms them; the regular poll stays the floor for anything file events miss.
 */
export function watchMissionStatuses(agentDir: string, onChange: () => void, debounceMs = 300): StatusWatch {
  const root = join(agentDir, "missions");
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let timer: Timer | undefined;

  const fire = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
    timer.unref?.();
    void sync();
  };

  const add = (dir: string) => {
    if (closed || watchers.has(dir)) return;
    try {
      watchers.set(dir, watch(dir, { persistent: false }, fire));
    } catch {
      // Missing directory or inotify limit: the poll floor and resync cover it.
    }
  };

  const sync = async () => {
    add(agentDir); // watches missions/ appearing under a fresh agent dir
    add(root);
    let workspaces: string[];
    try {
      workspaces = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return;
    }
    if (closed) return;
    for (const workspace of workspaces) {
      const dir = join(root, workspace);
      add(dir); // watches the status/ directory appearing inside a fresh workspace
      add(join(dir, "status"));
    }
  };

  const resync = setInterval(() => void sync(), RESYNC_MS);
  resync.unref?.();
  const ready = sync();

  return {
    ready,
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(resync);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
