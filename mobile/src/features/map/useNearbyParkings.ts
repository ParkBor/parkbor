import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createDebouncer } from '@/features/map/debounce';
import type { MapFilters } from '@/features/map/filters';
import type { LatLng, Region } from '@/features/map/geo';
import { resolveCenter } from '@/features/map/locationModel';
import { mapErrorKey, shouldRetry, type MapErrorKind } from '@/features/map/mapError';
import { parkingsApi } from '@/features/map/parkingsApi';
import type { Parking } from '@/features/map/schemas';
import { geoCellsAround } from '@/features/realtime/geohash';
import { useRealtimeGroups } from '@/features/realtime/useRealtime';
import {
  DEBOUNCE_MS,
  buildSearchParams,
  expandedRadius,
  nearbyQueryKey,
  shouldShowSearchHere,
  visibleRadiusM,
  type NearbyParams,
} from '@/features/map/search';

const STALE_TIME_MS = 30_000;
const NO_PARKINGS: readonly Parking[] = [];

/** An explicitly searched area ("Search this area"); null means "around the user". */
interface AreaSearch {
  center: LatLng;
  viewRadiusM: number;
}

export interface NearbyParkings {
  parkings: readonly Parking[];
  /** Nothing to show yet: waiting for location, or the first request is running. */
  isLoading: boolean;
  /** Any request in flight, including refreshes that keep showing older results. */
  isFetching: boolean;
  error: MapErrorKind | null;
  refetch: () => void;
  /** Radius the backend widened the search to, when it did (otherwise null). */
  expandedRadiusM: number | null;
  showSearchHere: boolean;
  searchHere: () => void;
  backToUser: () => void;
  onRegionChangeComplete: (region: Region) => void;
}

function regionCenter(region: Region): LatLng {
  return { lat: region.latitude, lng: region.longitude };
}

/**
 * Nearby parkings for the map. Results belong to the user's surroundings, or to the area chosen
 * with "Search this area". Panning only updates the viewport that decides whether that button is
 * shown; the 400 ms debounce keeps the button from flickering during fling/animation event bursts.
 * Responses live in memory only: the query cache is NOT persisted and is cleared on logout.
 * `isReady` holds the first request until the location outcome is known (skeleton meanwhile).
 */
export function useNearbyParkings(
  userPosition: LatLng | null,
  filters: MapFilters,
  isReady: boolean,
): NearbyParkings {
  const [area, setArea] = useState<AreaSearch | null>(null);
  const [viewRegion, setViewRegion] = useState<Region | null>(null);
  const latestRegion = useRef<Region | null>(null);

  const debouncer = useMemo(() => createDebouncer((region: Region) => setViewRegion(region), DEBOUNCE_MS), []);
  useEffect(() => () => debouncer.cancel(), [debouncer]);

  const searchCenter = area?.center ?? resolveCenter(userPosition);
  const params: NearbyParams = buildSearchParams(searchCenter, area?.viewRadiusM ?? null, filters);

  const query = useQuery({
    queryKey: nearbyQueryKey(params),
    queryFn: ({ signal }) => parkingsApi.nearby(params, signal),
    enabled: isReady,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIME_MS,
    retry: shouldRetry,
  });

  // Live free-spot counts: geo_<cell> for the cells of the searched area (patched into the cache).
  const isFocused = useIsFocused();
  const cells = geoCellsAround({ lat: params.lat, lng: params.lng }, params.radiusM); // a few dozen cells at most
  useRealtimeGroups(
    cells.map((id) => ({ kind: 'geo' as const, id })),
    isReady && isFocused,
  );

  const onRegionChangeComplete = useCallback(
    (region: Region) => {
      latestRegion.current = region;
      debouncer.call(region);
    },
    [debouncer],
  );

  const searchHere = useCallback(() => {
    debouncer.flush();
    const region = latestRegion.current;
    if (!region) return;
    setArea({ center: regionCenter(region), viewRadiusM: visibleRadiusM(region) });
  }, [debouncer]);

  const backToUser = useCallback(() => setArea(null), []);
  const { refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);

  const showSearchHere =
    viewRegion !== null &&
    shouldShowSearchHere(searchCenter, regionCenter(viewRegion), visibleRadiusM(viewRegion), {
      searchedM: params.radiusM,
      nextM: buildSearchParams(regionCenter(viewRegion), visibleRadiusM(viewRegion), filters).radiusM,
    });

  return {
    parkings: query.data?.results ?? NO_PARKINGS,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    error: query.isError ? mapErrorKey(query.error) : null,
    refetch: retry,
    expandedRadiusM: expandedRadius(params.radiusM, query.data?.radiusUsedM ?? null),
    showSearchHere,
    searchHere,
    backToUser,
    onRegionChangeComplete,
  };
}
