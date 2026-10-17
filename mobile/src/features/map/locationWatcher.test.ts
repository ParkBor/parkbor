import { describe, expect, it, vi } from 'vitest';

import type { LatLng } from '@/features/map/geo';
import { createLocationWatcher, type Fix, type WatcherDeps } from '@/features/map/locationWatcher';

const NOW = 1_000_000_000;
const fresh = (lat: number): Fix => ({ lat, lng: 69.2, timestamp: NOW - 1000, accuracy: 20 });

interface Harness {
  deps: WatcherDeps;
  positions: (LatLng | null)[];
  remove: ReturnType<typeof vi.fn>;
  emit: (fix: Fix) => void;
  resolveWatch: () => void;
  resolveLast: (fix: Fix | null) => void;
}

/** Deferred promises let tests interleave stop() with in-flight awaits. */
function harness(over: Partial<WatcherDeps> = {}): Harness {
  const positions: (LatLng | null)[] = [];
  const remove = vi.fn();
  let emit: (fix: Fix) => void = () => undefined;
  let resolveWatch: () => void = () => undefined;
  let resolveLast: (fix: Fix | null) => void = () => undefined;
  const deps: WatcherDeps = {
    getLastKnown: () => new Promise((resolve) => (resolveLast = resolve)),
    watch: (onFix) => {
      emit = onFix;
      return new Promise((resolve) => (resolveWatch = () => resolve({ remove })));
    },
    now: () => NOW,
    onPosition: (p) => positions.push(p),
    onError: vi.fn(),
    ...over,
  };
  return { deps, positions, remove, emit: (f) => emit(f), resolveWatch: () => resolveWatch(), resolveLast: (f) => resolveLast(f) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createLocationWatcher', () => {
  it('uses a fresh last known fix, then follows live fixes', async () => {
    const h = harness();
    const watcher = createLocationWatcher(h.deps);
    const started = watcher.start();
    h.resolveLast(fresh(41.1));
    await flush();
    h.resolveWatch();
    await started;
    h.emit(fresh(41.2));
    expect(h.positions).toEqual([{ lat: 41.1, lng: 69.2 }, { lat: 41.2, lng: 69.2 }]);
  });

  it('ignores a stale or inaccurate last known fix', async () => {
    const h = harness();
    const started = createLocationWatcher(h.deps).start();
    h.resolveLast({ lat: 40, lng: 68, timestamp: NOW - 10 * 60_000, accuracy: 20 });
    await flush();
    h.resolveWatch();
    await started;
    expect(h.positions).toEqual([]);
  });

  it('does not install a watcher when stop() happens while the watch is being created', async () => {
    const h = harness();
    const watcher = createLocationWatcher(h.deps);
    const started = watcher.start();
    h.resolveLast(null);
    await flush();
    watcher.stop();
    h.resolveWatch();
    await started;
    expect(h.remove).toHaveBeenCalledTimes(1);
    h.emit(fresh(41.9));
    expect(h.positions.filter((p) => p !== null)).toEqual([]);
  });

  it('drops a last known fix that resolves after stop()', async () => {
    const h = harness();
    const watcher = createLocationWatcher(h.deps);
    const started = watcher.start();
    watcher.stop();
    h.resolveLast(fresh(41.5));
    await flush();
    h.resolveWatch();
    await started;
    expect(h.positions.filter((p) => p !== null)).toEqual([]);
  });

  it('stop() removes the subscription and clears the position (permission revoked)', async () => {
    const h = harness();
    const watcher = createLocationWatcher(h.deps);
    const started = watcher.start();
    h.resolveLast(null);
    await flush();
    h.resolveWatch();
    await started;
    h.emit(fresh(41.3));
    watcher.stop();
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.positions.at(-1)).toBeNull();
    h.emit(fresh(41.4));
    expect(h.positions.at(-1)).toBeNull();
  });

  it('pause keeps the last position (tab lost focus)', async () => {
    const h = harness();
    const watcher = createLocationWatcher(h.deps);
    const started = watcher.start();
    h.resolveLast(null);
    await flush();
    h.resolveWatch();
    await started;
    h.emit(fresh(41.3));
    watcher.stop({ keepPosition: true });
    expect(h.remove).toHaveBeenCalledTimes(1);
    expect(h.positions).toEqual([{ lat: 41.3, lng: 69.2 }]);
  });

  it('does not start twice while a watcher is active', async () => {
    const watch = vi.fn().mockResolvedValue({ remove: vi.fn() });
    const watcher = createLocationWatcher({
      getLastKnown: async () => null,
      watch,
      now: () => NOW,
      onPosition: vi.fn(),
      onError: vi.fn(),
    });
    await watcher.start();
    await watcher.start();
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it('can start again after stop', async () => {
    const watch = vi.fn().mockResolvedValue({ remove: vi.fn() });
    const watcher = createLocationWatcher({
      getLastKnown: async () => null,
      watch,
      now: () => NOW,
      onPosition: vi.fn(),
      onError: vi.fn(),
    });
    await watcher.start();
    watcher.stop();
    await watcher.start();
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it('reports platform failures through onError without leaking details', async () => {
    const onError = vi.fn();
    const watcher = createLocationWatcher({
      getLastKnown: async () => null,
      watch: async () => {
        throw new Error('lat=41.1 lng=69.2 secret');
      },
      now: () => NOW,
      onPosition: vi.fn(),
      onError,
    });
    await watcher.start();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith();
  });
});
