export interface Batcher<K, V> {
  add: (key: K, value: V) => void;
  /** Delivers what is pending right now (no-op when nothing is). */
  flush: () => void;
  cancel: () => void;
}

export interface BatcherTimers {
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

const REAL_TIMERS: BatcherTimers = {
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Coalesces bursts: the newest value per key wins, delivered at most once per `intervalMs`
 * (throttle, not debounce: a constant stream still gets through). A busy parking lot can change
 * several times a second; the cache and the API only need the latest state.
 */
export function createBatcher<K, V>(
  deliver: (batch: ReadonlyMap<K, V>) => void,
  intervalMs: number,
  timers: BatcherTimers = REAL_TIMERS,
): Batcher<K, V> {
  let pending = new Map<K, V>();
  let handle: unknown = null;

  const flush = (): void => {
    if (handle !== null) timers.clearTimer(handle);
    handle = null;
    if (pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    deliver(batch);
  };

  return {
    add(key, value) {
      pending.set(key, value);
      handle ??= timers.setTimer(flush, intervalMs);
    },
    flush,
    cancel() {
      if (handle !== null) timers.clearTimer(handle);
      handle = null;
      pending = new Map();
    },
  };
}
