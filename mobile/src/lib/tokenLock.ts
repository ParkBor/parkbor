export interface TokenLock {
  /**
   * Runs `task` after every previously queued task settled. Not re-entrant: a task must never
   * call `run` on the same lock and await it (deadlock).
   */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Promise-queue mutex. EVERY mutation of token state (rotated refresh token, sign-in, sign-out,
 * pending revocations) goes through one lock, so a late writer can never interleave with - and
 * resurrect state after - a newer one.
 */
export function createTokenLock(): TokenLock {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}
