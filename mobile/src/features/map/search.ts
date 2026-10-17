import { DEFAULT_FILTERS, type MapFilters } from '@/features/map/filters';
import { haversineM, METERS_PER_DEGREE, type LatLng, type Region } from '@/features/map/geo';
import type { SlotType, SortMode } from '@/features/map/schemas';

export const COORD_DECIMALS = 3;
export const MIN_RADIUS_M = 100;
export const MAX_RADIUS_M = 10_000;
export const RADIUS_STEP_M = 100;
export const RESULT_LIMIT = 50;
export const DEBOUNCE_MS = 400;

/** The "search this area" button needs at least this much movement... */
const SEARCH_HERE_MIN_M = 500;
/** ...or this share of the visible radius, whichever is larger. */
const SEARCH_HERE_VIEW_SHARE = 0.25;

/** Show a bit more than the search radius so edge markers are not clipped. */
const REGION_PADDING = 1.2;

export interface NearbyParams {
  lat: number;
  lng: number;
  radiusM: number;
  slotType: SlotType | null;
  limit: number;
  sort: SortMode;
  onlyOpen: boolean;
}

function roundCoord(value: number): number {
  const factor = 10 ** COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** Half of the larger visible span, in meters. */
export function visibleRadiusM(region: Region): number {
  const heightM = region.latitudeDelta * METERS_PER_DEGREE;
  const widthM = region.longitudeDelta * METERS_PER_DEGREE * Math.cos((region.latitude * Math.PI) / 180);
  return Math.max(heightM, widthM) / 2;
}

/** Initial map region that comfortably contains `radiusM` around `center`. */
export function regionAround(center: LatLng, radiusM: number): Region {
  const latitudeDelta = ((radiusM * 2) / METERS_PER_DEGREE) * REGION_PADDING;
  const longitudeDelta = latitudeDelta / Math.max(0.1, Math.cos((center.lat * Math.PI) / 180));
  return { latitude: center.lat, longitude: center.lng, latitudeDelta, longitudeDelta };
}

function clampRadius(radiusM: number): number {
  const stepped = Math.round(radiusM / RADIUS_STEP_M) * RADIUS_STEP_M;
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, stepped));
}

/**
 * Request params for a search around `center`. The radius never exceeds the filter radius and,
 * when the viewport is known, the visible radius. Values are rounded so that the params and the
 * query key describe exactly the same request.
 */
export function buildSearchParams(
  center: LatLng,
  viewRadiusM: number | null,
  filters: MapFilters = DEFAULT_FILTERS,
): NearbyParams {
  const wanted = viewRadiusM === null ? filters.radiusM : Math.min(viewRadiusM, filters.radiusM);
  return {
    lat: roundCoord(center.lat),
    lng: roundCoord(center.lng),
    radiusM: clampRadius(wanted),
    slotType: filters.slotType,
    limit: RESULT_LIMIT,
    sort: filters.sort,
    onlyOpen: filters.onlyOpen,
  };
}

/** The radius the backend actually used, when it widened the request (otherwise null). */
export function expandedRadius(requestedM: number, usedM: number | null): number | null {
  return usedM !== null && usedM > requestedM ? usedM : null;
}

export function nearbyQueryKey(params: NearbyParams): readonly unknown[] {
  return [
    'parkings',
    'nearby',
    roundCoord(params.lat),
    roundCoord(params.lng),
    params.radiusM,
    params.slotType,
    params.sort,
    params.onlyOpen,
  ];
}

/** Zooming out shows the button once the next search would cover this much more radius. */
const SEARCH_HERE_GROWTH = 1.25;

/**
 * Show "search this area" when the map center left the searched area, or (with `radii`) when the
 * visible area grew enough that a new search would reach further than the current one.
 */
export function shouldShowSearchHere(
  searchedCenter: LatLng | null,
  viewCenter: LatLng,
  viewRadiusM: number,
  radii?: { searchedM: number; nextM: number },
): boolean {
  if (searchedCenter === null) return false;
  const threshold = Math.max(SEARCH_HERE_MIN_M, viewRadiusM * SEARCH_HERE_VIEW_SHARE);
  if (haversineM(searchedCenter, viewCenter) >= threshold) return true;
  return radii !== undefined && radii.nextM >= radii.searchedM * SEARCH_HERE_GROWTH;
}
