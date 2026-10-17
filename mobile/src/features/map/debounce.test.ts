import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDebouncer } from '@/features/map/debounce';

describe('createDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once, with the last arguments, after the quiet period', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 400);
    d.call(1);
    vi.advanceTimersByTime(300);
    d.call(2);
    vi.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
  });

  it('fires again for a later burst', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 400);
    d.call('a');
    vi.advanceTimersByTime(400);
    d.call('b');
    vi.advanceTimersByTime(400);
    expect(fn.mock.calls).toEqual([['a'], ['b']]);
  });

  it('cancel drops the pending call', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 400);
    d.call(1);
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('flush runs the pending call immediately and only once', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 400);
    d.call(7);
    d.flush();
    expect(fn).toHaveBeenCalledWith(7);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush without a pending call does nothing', () => {
    const fn = vi.fn();
    createDebouncer(fn, 400).flush();
    expect(fn).not.toHaveBeenCalled();
  });
});
