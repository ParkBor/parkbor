import { useQuery } from '@tanstack/react-query';

import type { LatLng } from '@/features/map/geo';
import { routeErrorKind, shouldRetry, type RouteErrorKind } from '@/features/route/routeError';
import type { Route } from '@/features/route/routeSchemas';
import { routeQueryKey, routesApi } from '@/features/route/routesApi';

export const ROUTE_STALE_TIME_MS = 60_000;

export interface RouteState {
  route: Route | null;
  /** First load in progress (no route to show yet). */
  isLoading: boolean;
  /** Any request in flight, including a re-request while the previous route stays visible. */
  isFetching: boolean;
  error: RouteErrorKind | null;
  refetch: () => void;
}

/**
 * Route between two points. Disabled until both exist. The query key uses coordinates rounded to
 * ~11 m (same as the server cache) so GPS noise does not create new requests. Responses live in
 * the in-memory query cache only (never persisted) and are cleared with the session.
 */
export function useRoute(from: LatLng | null, to: LatLng | null): RouteState {
  const query = useQuery({
    queryKey: from && to ? routeQueryKey(from, to) : ['route', 'idle'],
    queryFn: ({ signal }) => {
      if (!from || !to) throw new RangeError('Route endpoints are missing');
      return routesApi.route({ from, to }, signal);
    },
    enabled: from !== null && to !== null,
    // A straight-line fallback is never "fresh": the real route may be available a moment later.
    staleTime: (query) => (query.state.data?.isApproximate ? 0 : ROUTE_STALE_TIME_MS),
    retry: shouldRetry,
    refetchOnWindowFocus: false,
  });
  const { refetch } = query;
  return {
    route: query.data ?? null,
    isLoading: query.isPending && query.fetchStatus !== 'idle',
    isFetching: query.isFetching,
    error: query.isError ? routeErrorKind(query.error) : null,
    refetch: () => void refetch(),
  };
}
