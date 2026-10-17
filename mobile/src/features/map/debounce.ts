export interface Debouncer<A extends unknown[]> {
  call: (...args: A) => void;
  cancel: () => void;
  /** Runs the pending call right away (no-op when nothing is pending). */
  flush: () => void;
}

/** Trailing-edge debounce; the last arguments win. */
export function createDebouncer<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): Debouncer<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  const flush = (): void => {
    if (pending === null) return;
    const args = pending;
    cancel();
    fn(...args);
  };

  const call = (...args: A): void => {
    if (timer !== null) clearTimeout(timer);
    pending = args;
    timer = setTimeout(flush, waitMs);
  };

  return { call, cancel, flush };
}
