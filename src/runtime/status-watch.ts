import { watch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface StatusWatch {
  ready: Promise<void>;
  close(): void;
}

export function watchMissionStatuses(agentDir: string, onChange: () => void, debounceMs = 300): StatusWatch {
  const root = join(agentDir, "missions");
  const watchers = new Map<string, { watcher: FSWatcher; identity: string }>();
  let closed = false;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let scanning: Promise<void> | undefined;
  let scanPending = false;

  // Leading-edge coalescing bounds latency even when a mission writes continuously.
  function wake(): void {
    if (closed || wakeTimer !== undefined) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      if (!closed) onChange();
    }, debounceMs);
    wakeTimer.unref?.();
  }
  function rescan(): void {
    if (closed || scanTimer !== undefined) return;
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      void sync();
    }, debounceMs);
    scanTimer.unref?.();
  }
  async function reconcile(): Promise<void> {
    const desired = new Map<string, "agent" | "root" | "workspace" | "status">([[agentDir, "agent"], [root, "root"]]);
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        desired.set(dir, "workspace");
        desired.set(join(dir, "status"), "status");
      }
    } catch { /* The periodic pass still covers unavailable directories. */ }
    for (const [dir, kind] of desired) {
      let identity: string;
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) continue;
        identity = `${info.dev}:${info.ino}`;
      } catch {
        watchers.get(dir)?.watcher.close();
        watchers.delete(dir);
        continue;
      }
      if (closed) return;
      const previous = watchers.get(dir);
      if (previous?.identity === identity) continue;
      previous?.watcher.close();
      watchers.delete(dir);
      try {
        const watcher = watch(dir, { persistent: false }, (event, filename) => {
          const name = filename?.toString();
          if (kind === "status") {
            if (!name || name.endsWith(".json")) wake();
            if (!name) rescan();
          } else if (!name || (kind === "agent" ? name === "missions" : kind === "workspace" ? name === "status" : event === "rename")) {
            rescan();
            wake();
          }
        });
        watcher.on("error", () => {
          if (watchers.get(dir)?.watcher !== watcher) return;
          watcher.close();
          watchers.delete(dir);
          rescan();
        });
        watchers.set(dir, { watcher, identity });
      } catch { /* Polling remains the fallback for inotify limits. */ }
    }
    for (const [dir, entry] of watchers) {
      if (desired.has(dir)) continue;
      entry.watcher.close();
      watchers.delete(dir);
    }
  }
  function sync(): Promise<void> {
    if (closed) return Promise.resolve();
    if (scanning) {
      scanPending = true;
      return scanning;
    }
    scanning = reconcile().finally(() => {
      scanning = undefined;
      if (scanPending && !closed) {
        scanPending = false;
        rescan();
      }
    });
    return scanning;
  }
  const resync = setInterval(() => void sync(), 10_000);
  resync.unref?.();
  const ready = sync();
  return {
    ready,
    close() {
      closed = true;
      clearTimeout(wakeTimer);
      clearTimeout(scanTimer);
      clearInterval(resync);
      for (const { watcher } of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
