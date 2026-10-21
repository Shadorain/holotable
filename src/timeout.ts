/** Rejects with `message` after `ms`; the timer is unref'd and cleared so it never keeps the process alive. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(message)), ms);
  timer.unref?.();
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
