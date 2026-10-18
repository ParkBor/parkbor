import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBatcher } from '@/features/realtime/batcher';

afterEach(() => vi.useRealTimers());

describe('createBatcher', () => {
  it('delivers once per interval with the newest value per key', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const batcher = createBatcher<string, number>(deliver, 500);
    batcher.add('a', 1);
    batcher.add('b', 2);
    batcher.add('a', 3);
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(deliver).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect([...(deliver.mock.calls[0]?.[0] as Map<string, number>)]).toEqual([
      ['a', 3],
      ['b', 2],
    ]);
  });

  it('is a throttle: a constant stream is still delivered every interval', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const batcher = createBatcher<string, number>(deliver, 100);
    for (let i = 0; i < 10; i += 1) {
      batcher.add('a', i);
      vi.advanceTimersByTime(50);
    }
    expect(deliver.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('starts a fresh batch after a delivery', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const batcher = createBatcher<string, number>(deliver, 100);
    batcher.add('a', 1);
    vi.advanceTimersByTime(100);
    batcher.add('b', 2);
    vi.advanceTimersByTime(100);
    expect([...(deliver.mock.calls[1]?.[0] as Map<string, number>).keys()]).toEqual(['b']);
  });

  it('flush() delivers immediately and does nothing when empty', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const batcher = createBatcher<string, number>(deliver, 100);
    batcher.flush();
    expect(deliver).not.toHaveBeenCalled();
    batcher.add('a', 1);
    batcher.flush();
    expect(deliver).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops what is pending', () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const batcher = createBatcher<string, number>(deliver, 100);
    batcher.add('a', 1);
    batcher.cancel();
    vi.advanceTimersByTime(1000);
    expect(deliver).not.toHaveBeenCalled();
  });
});
