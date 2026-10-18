import { describe, expect, it } from 'vitest';

import { MAX_FRAMES_PER_SECOND, createFrameLimiter } from '@/features/realtime/frameLimiter';

describe('createFrameLimiter', () => {
  it('lets the budget through and drops the excess within one second', () => {
    let t = 0;
    const limiter = createFrameLimiter(() => t);
    const results = Array.from({ length: MAX_FRAMES_PER_SECOND + 5 }, () => limiter.allow());
    expect(results.filter(Boolean)).toHaveLength(MAX_FRAMES_PER_SECOND);
    expect(results.slice(-5)).toEqual([false, false, false, false, false]);
    t = 999;
    expect(limiter.allow()).toBe(false);
  });

  it('starts a new budget every second', () => {
    let t = 0;
    const limiter = createFrameLimiter(() => t, 2);
    limiter.allow();
    limiter.allow();
    expect(limiter.allow()).toBe(false);
    t = 1000;
    expect(limiter.allow()).toBe(true);
  });

  it('survives a clock that moves backwards', () => {
    let t = 5000;
    const limiter = createFrameLimiter(() => t, 1);
    limiter.allow();
    t = 100;
    expect(limiter.allow()).toBe(true);
  });
});
