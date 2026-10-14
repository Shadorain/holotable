export type ChangeListener = () => void;

const listeners = new Set<ChangeListener>();

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
