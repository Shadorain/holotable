export type ChangeListener = () => void;

const listeners = new Set<ChangeListener>();

/**
 * Anything that can change what /api/operations or /api/projection returns calls this:
 * every appendEvent, every watcher pass that observed different extras, every status-file
 * wakeup. The server fans it out to open /api/stream clients; the page then refetches
 * instead of blind-polling.
 */
export function notifyChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A dead listener must never break the writer that fired it.
    }
  }
}

export function onChanged(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
