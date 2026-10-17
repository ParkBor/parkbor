import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { bookingApi } from '@/features/booking/bookingApi';
import { evaluateQuote, type QuoteFlags } from '@/features/booking/quoteState';
import { quoteKeys } from '@/features/booking/queryKeys';
import type { SlotType } from '@/features/map/schemas';
import { shouldRetry } from '@/features/map/mapError';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

const DEBOUNCE_MS = 400;
const QUOTE_STALE_MS = 15_000;

export interface QuoteInput {
  lotId: string;
  slotType: SlotType;
  startMs: number;
  endMs: number;
  /** false while the period is invalid (no point asking the server). */
  isValid: boolean;
}

/**
 * Live price + availability for the chosen period. The request is debounced (400 ms, so +/-15 min
 * taps do not fire a request each) and in-flight requests are aborted when the period changes
 * (TanStack passes `signal`; axios cancels). Server quotes are throttled at 120/min.
 *
 * keepPreviousData keeps the screen from flashing empty, but the previous period's data must
 * never be payable: `verdict` (quoteState) compares the data with the requested period and the
 * placeholder/fetching flags, and only a current quote enables "Pay and book".
 */
export function useQuote(request: QuoteInput) {
  const debounced = useDebouncedValue(request, DEBOUNCE_MS);
  const isSettled =
    debounced.lotId === request.lotId &&
    debounced.slotType === request.slotType &&
    debounced.startMs === request.startMs &&
    debounced.endMs === request.endMs;
  const enabled = debounced.isValid && request.isValid;
  const { lotId, slotType, startMs, endMs } = debounced;

  const price = useQuery({
    queryKey: quoteKeys.price(lotId, slotType, startMs, endMs),
    queryFn: ({ signal }) => bookingApi.price(lotId, { startMs, endMs, slotType }, signal),
    enabled,
    staleTime: QUOTE_STALE_MS,
    retry: shouldRetry,
    placeholderData: keepPreviousData,
  });
  const availability = useQuery({
    queryKey: quoteKeys.availability(lotId, slotType, startMs, endMs),
    queryFn: ({ signal }) => bookingApi.availability(lotId, { startMs, endMs, slotType }, signal),
    enabled,
    staleTime: QUOTE_STALE_MS,
    retry: shouldRetry,
    placeholderData: keepPreviousData,
  });

  const flags: QuoteFlags = {
    isSettled,
    isPlaceholder: price.isPlaceholderData || availability.isPlaceholderData,
    isFetching: price.isFetching || availability.isFetching,
  };
  const verdict = evaluateQuote(request, price.data, availability.data, flags);
  return { price, availability, flags, verdict };
}
