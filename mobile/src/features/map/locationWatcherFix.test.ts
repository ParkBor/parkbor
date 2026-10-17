import { describe, expect, it, vi } from 'vitest';

import { createLocationWatcher, type Fix } from '@/features/map/locationWatcher';

describe('createLocationWatcher onFix', () => {
  it('passes the full fix (with accuracy) and clears it on stop', async () => {
    let push: (fix: Fix) => void = () => {};
    const onFix = vi.fn();
    const watcher = createLocationWatcher({
      getLastKnown: async () => null,
      watch: async (cb) => {
        push = cb;
        return { remove: () => {} };
      },
      now: () => 1000,
      onPosition: () => {},
      onFix,
      onError: () => {},
    });
    await watcher.start();
    const fix: Fix = { lat: 41.3, lng: 69.2, timestamp: 1000, accuracy: 7 };
    push(fix);
    expect(onFix).toHaveBeenLastCalledWith(fix);
    watcher.stop({ keepPosition: true });
    expect(onFix).toHaveBeenCalledTimes(1);
    watcher.stop();
    expect(onFix).toHaveBeenLastCalledWith(null);
  });
});
