import { afterEach, describe, expect, it, vi } from 'vitest';

import { TimeoutError, withTimeout } from '@/lib/timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('resolves with the value when fast enough', async () => {
    await expect(withTimeout(Promise.resolve(7), 100)).resolves.toBe(7);
  });

  it('propagates the original rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 100)).rejects.toThrow('boom');
  });

  it('rejects with TimeoutError when the promise hangs', async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise<number>(() => undefined), 50);
    const assertion = expect(result).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
  });
});
