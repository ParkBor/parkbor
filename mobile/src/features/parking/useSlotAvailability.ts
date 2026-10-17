import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { bookingApi } from '@/features/booking/bookingApi';
import { quoteKeys } from '@/features/booking/queryKeys';
import { serverClock } from '@/features/booking/serverClock';
import { ceilToStep, endFromDuration } from '@/features/booking/timeSlots';
import { shouldRetry } from '@/features/map/mapError';
import { SLOT_TYPES } from '@/features/map/schemas';
import { slotTypeRows, type SlotTypeRow } from '@/features/parking/parkingView';

const WINDOW_MIN = 60;
const STALE_MS = 15_000;

export interface SlotAvailability {
  rows: SlotTypeRow[];
  isLoading: boolean;
  /** Waiting for a connection (queries paused): shown as "no internet", not as a spinner. */
  isOffline: boolean;
  hasError: boolean;
}

/** Free spots per spot type for the next hour (4 availability requests, keys stable per visit). */
export function useSlotAvailability(lotId: string, isEnabled: boolean): SlotAvailability {
  const period = useMemo(() => {
    const startMs = ceilToStep(serverClock.now());
    return { startMs, endMs: endFromDuration(startMs, WINDOW_MIN) };
  }, []);

  const queries = useQueries({
    queries: SLOT_TYPES.map((slotType) => ({
      queryKey: quoteKeys.availability(lotId, slotType, period.startMs, period.endMs),
      queryFn: ({ signal }: { signal: AbortSignal }) => bookingApi.availability(lotId, { ...period, slotType }, signal),
      enabled: isEnabled,
      staleTime: STALE_MS,
      retry: shouldRetry,
    })),
  });

  const rows = slotTypeRows(SLOT_TYPES.map((slotType, index) => ({ slotType, data: queries[index]?.data ?? null })));
  const isOffline = queries.every((query) => query.isPending && query.fetchStatus === 'paused');
  return {
    rows,
    isOffline,
    isLoading: !isOffline && queries.some((query) => query.isPending),
    hasError: queries.every((query) => query.isError),
  };
}
