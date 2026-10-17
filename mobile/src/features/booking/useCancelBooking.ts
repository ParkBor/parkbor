import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

import { bookingApi } from '@/features/booking/bookingApi';
import { bookingKeys } from '@/features/booking/queryKeys';
import { withSerializationRetry } from '@/features/booking/serializationRetry';
import { qrCache } from '@/features/booking/qrStore';
import { useBookingCacheUpdater } from '@/features/booking/useBookings';
import { shouldRetry } from '@/features/map/mapError';

/** What a cancellation would refund, asked fresh every time the dialog opens (the policy depends on the clock). */
export function useCancelPreview(bookingId: string, isOpen: boolean) {
  return useQuery({
    queryKey: bookingKeys.cancelPreview(bookingId),
    queryFn: ({ signal }) => bookingApi.cancelPreview(bookingId, signal),
    enabled: isOpen,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    networkMode: 'offlineFirst', // offline: fail fast to the "amount unknown" text instead of waiting
    retry: shouldRetry,
  });
}

/**
 * Cancel. Repeated taps are ignored while a request runs (`busy` ref covers the gap before React
 * re-renders); the endpoint is idempotent anyway (a second cancel answers 200 with the booking).
 * On success the booking cache is updated and the offline QR copy is deleted.
 */
export function useCancelBooking(bookingId: string) {
  const queryClient = useQueryClient();
  const updateCache = useBookingCacheUpdater();
  const busy = useRef(false);
  const mutation = useMutation({
    mutationFn: () => withSerializationRetry(() => bookingApi.cancel(bookingId)),
    onSuccess: async (booking) => {
      updateCache(booking);
      await qrCache.remove(bookingId);
      queryClient.removeQueries({ queryKey: bookingKeys.qr(bookingId) });
    },
    onError: () => {
      // The status may have changed under us (e.g. check-in): show the truth.
      void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(bookingId) });
    },
  });
  const { mutateAsync } = mutation;
  const cancel = async (): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    try {
      await mutateAsync();
      return true;
    } catch {
      return false; // the error is on `mutation.error`
    } finally {
      busy.current = false;
    }
  };
  return { cancel, mutation };
}
