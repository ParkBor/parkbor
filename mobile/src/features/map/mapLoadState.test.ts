import { describe, expect, it } from 'vitest';

import { INITIAL_MAP_LOAD, MAP_LOAD_TIMEOUT_MS, reduceMapLoad } from '@/features/map/mapLoadState';

describe('reduceMapLoad', () => {
  it('starts loading', () => {
    expect(INITIAL_MAP_LOAD).toEqual({ status: 'loading', attempt: 0 });
  });

  it('loaded -> ready', () => {
    expect(reduceMapLoad(INITIAL_MAP_LOAD, 'loaded').status).toBe('ready');
  });

  it('failed or timed out while loading -> failed', () => {
    expect(reduceMapLoad(INITIAL_MAP_LOAD, 'failed').status).toBe('failed');
    expect(reduceMapLoad(INITIAL_MAP_LOAD, 'timeout').status).toBe('failed');
    expect(MAP_LOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });

  it('a map that already loaded is not replaced by an error screen later', () => {
    const ready = reduceMapLoad(INITIAL_MAP_LOAD, 'loaded');
    expect(reduceMapLoad(ready, 'failed')).toBe(ready);
    expect(reduceMapLoad(ready, 'timeout')).toBe(ready);
    expect(reduceMapLoad(ready, 'loaded')).toBe(ready);
  });

  it('a timeout that fires after the style loaded is harmless', () => {
    expect(reduceMapLoad(reduceMapLoad(INITIAL_MAP_LOAD, 'loaded'), 'timeout').status).toBe('ready');
  });

  it('retry from failed starts a new attempt (remount key changes)', () => {
    const failed = reduceMapLoad(INITIAL_MAP_LOAD, 'failed');
    expect(reduceMapLoad(failed, 'retry')).toEqual({ status: 'loading', attempt: 1 });
    expect(reduceMapLoad(reduceMapLoad(reduceMapLoad(failed, 'retry'), 'failed'), 'retry').attempt).toBe(2);
  });

  it('retry is ignored unless the map failed', () => {
    expect(reduceMapLoad(INITIAL_MAP_LOAD, 'retry')).toBe(INITIAL_MAP_LOAD);
    const ready = reduceMapLoad(INITIAL_MAP_LOAD, 'loaded');
    expect(reduceMapLoad(ready, 'retry')).toBe(ready);
  });

  it('a failure after a retry is possible again', () => {
    const failed = reduceMapLoad(INITIAL_MAP_LOAD, 'failed');
    const again = reduceMapLoad(reduceMapLoad(failed, 'retry'), 'failed');
    expect(again).toEqual({ status: 'failed', attempt: 1 });
  });
});
