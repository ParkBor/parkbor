import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { bookingApi, type CreateResult } from '@/features/booking/bookingApi';
import { classifyBookingError, mustRefreshQuote } from '@/features/booking/bookingErrors';
import { bookingKeeper } from '@/features/booking/bookingKeeper';
import { bookingFingerprint, type CreateBookingPayload } from '@/features/booking/idempotencyKey';
import { withSerializationRetry } from '@/features/booking/serializationRetry';
import { useBookingCacheUpdater } from '@/features/booking/useBookings';
import type { Failure } from '@/lib/failure';

/**
 * POST /bookings with ONE Idempotency-Key per attempt:
 * - the same payload (double tap, retry after a network error / 503 / timeout) reuses the key, so
 *   the server answers with the original booking instead of creating a second one;
 * - a changed payload gets a new key; success releases the key; the server refusing the key
 *   (idempotency_conflict / key_invalid) rotates it.
 * The key and payload are never logged.
 */
export function useCreateBooking() {
  const queryClient = useQueryClient();
  const updateCache = useBookingCacheUpdater();
  // App-wide (memory only): reopening the modal after a lost response keeps the key.
  const keeper = bookingKeeper;
  const busy = useRef(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const mutation = useMutation({
    mutationFn: (payload: CreateBookingPayload): Promise<CreateResult> => {
      const key = keeper.keyFor(bookingFingerprint(payload));
      return withSerializationRetry(() => bookingApi.create(payload, key));
    },
    retry: false, // retries are the user's explicit tap, with the same key
    onSuccess: (result) => {
      keeper.release();
      updateCache(result.booking);
    },
    onError: (error: unknown) => {
      const classified = classifyBookingError(error);
      if (classified.retry === 'new_key') keeper.rotate();
      if (mustRefreshQuote(classified)) void queryClient.invalidateQueries({ queryKey: ['parkings'] });
    },
  });
  const { mutateAsync } = mutation;

  /**
   * Resolves to the result, or null on failure (then `failure` is set and `onFailure` is told).
   * Ignores taps while one is running.
   */
  const submit = async (
    payload: CreateBookingPayload,
    onFailure?: (failure: Failure) => void,
  ): Promise<CreateResult | null> => {
    if (busy.current) return null;
    busy.current = true;
    setFailure(null);
    try {
      return await mutateAsync(payload);
    } catch (error: unknown) {
      const classified = classifyBookingError(error);
      setFailure(classified);
      onFailure?.(classified);
      return null;
    } finally {
      busy.current = false;
    }
  };

  return { submit, isPending: mutation.isPending, failure, clearFailure: () => setFailure(null) };
}
