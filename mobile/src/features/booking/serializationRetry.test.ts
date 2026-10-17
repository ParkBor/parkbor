import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { withSerializationRetry } from '@/features/booking/serializationRetry';

function httpError(status: number, code?: string): AxiosError {
  const response = { status, data: code ? { code } : {}, headers: {}, statusText: '', config: {} } as unknown as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, response);
}

const noWait = (): Promise<void> => Promise.resolve();

describe('withSerializationRetry', () => {
  it('returns the first result when nothing fails', async () => {
    const task = vi.fn().mockResolvedValue('ok');
    await expect(withSerializationRetry(task, noWait)).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('retries ONCE after 503 serialization_retry (the caller reuses the same Idempotency-Key)', async () => {
    const task = vi.fn().mockRejectedValueOnce(httpError(503, 'serialization_retry')).mockResolvedValue('ok');
    const wait = vi.fn(noWait);
    await expect(withSerializationRetry(task, wait)).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('gives up after the second failure and surfaces it', async () => {
    const failure = httpError(503, 'serialization_retry');
    const task = vi.fn().mockRejectedValue(failure);
    await expect(withSerializationRetry(task, noWait)).rejects.toBe(failure);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('does not retry other errors', async () => {
    for (const failure of [httpError(503, 'lock_timeout'), httpError(409, 'no_slot_available'), new Error('x')]) {
      const task = vi.fn().mockRejectedValue(failure);
      await expect(withSerializationRetry(task, noWait)).rejects.toBe(failure);
      expect(task).toHaveBeenCalledTimes(1);
    }
  });
});
