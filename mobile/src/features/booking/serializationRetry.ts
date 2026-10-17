import { parseApiError } from '@/lib/errors';

const RETRY_DELAY_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 503 `serialization_retry` (POST /bookings, cancel, extend): the server already retried once
 * internally and it is safe to repeat. `task` must reuse the SAME Idempotency-Key (create does:
 * the key comes from the keeper), so no duplicate booking can appear. One automatic retry;
 * a second failure is shown to the user ("try again in a moment").
 */
export async function withSerializationRetry<T>(
  task: () => Promise<T>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  try {
    return await task();
  } catch (error: unknown) {
    const info = parseApiError(error);
    if (info.status !== 503 || info.code !== 'serialization_retry') throw error;
    await wait(RETRY_DELAY_MS);
    return task();
  }
}
