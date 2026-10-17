import { useMemo } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import { bookingApi, type BookingScope } from '@/features/booking/bookingApi';
import type { Booking } from '@/features/booking/bookingSchemas';
import { isLiveStatus } from '@/features/booking/statusView';
import { bookingKeys } from '@/features/booking/queryKeys';
import { useIsAuthenticated } from '@/features/booking/useAuthenticated';
import { shouldRetry } from '@/features/map/mapError';

const PAGE_SIZE = 20;
const LIST_STALE_MS = 15_000;
const DETAIL_STALE_MS = 10_000;
/** A live booking (payment, check-in, expiry) can change on the server any moment. */
const LIVE_POLL_MS = 15_000;

/** One tab of "My bookings": 20 per page, next page requested by number (the server's `next` URL is never followed). */
export function useBookingsList(scope: BookingScope) {
  const isAuthenticated = useIsAuthenticated();
  const query = useInfiniteQuery({
    queryKey: bookingKeys.list(scope),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => bookingApi.list({ scope, page: pageParam, pageSize: PAGE_SIZE }, signal),
    getNextPageParam: (last, _pages, lastPageParam) => (last.hasNext ? lastPageParam + 1 : undefined),
    enabled: isAuthenticated,
    staleTime: LIST_STALE_MS,
    retry: shouldRetry,
  });
  const pages = query.data?.pages;
  const items = useMemo(() => {
    const seen = new Set<string>();
    const unique: Booking[] = [];
    for (const page of pages ?? []) {
      for (const booking of page.results) {
        if (!seen.has(booking.id)) {
          seen.add(booking.id);
          unique.push(booking);
        }
      }
    }
    return unique;
  }, [pages]);
  const skipped = (pages ?? []).reduce((sum, page) => sum + page.skippedCount, 0);
  return { ...query, items, skipped };
}

/**
 * A single booking; polled while its status can still change. Memory cache only. `pollMs` lets the
 * payment screen follow the extended hold more closely than the default 15 s.
 */
export function useBooking(id: string | null, pollMs: number = LIVE_POLL_MS) {
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: bookingKeys.detail(id ?? 'none'),
    queryFn: ({ signal }) => bookingApi.get(id ?? '', signal),
    enabled: id !== null && isAuthenticated,
    // A booking already in memory stays readable offline; the first load reports the network error.
    networkMode: 'offlineFirst',
    staleTime: DETAIL_STALE_MS,
    retry: shouldRetry,
    refetchInterval: (query) => (query.state.data && isLiveStatus(query.state.data.status) ? pollMs : false),
  });
}

/** After a write: put the fresh booking in the detail cache and refresh the lists. */
export function useBookingCacheUpdater() {
  const queryClient = useQueryClient();
  return (booking: Booking): void => {
    queryClient.setQueryData(bookingKeys.detail(booking.id), booking);
    void queryClient.invalidateQueries({ queryKey: [...bookingKeys.all, 'list'] });
  };
}
