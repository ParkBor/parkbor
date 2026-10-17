import type { AxiosInstance } from 'axios';

import { isValidLatLng, type LatLng } from '@/features/map/geo';
import { parseRouteResponse, type Route } from '@/features/route/routeSchemas';
import { api } from '@/lib/api';

/** The origin is rounded to ~11 m, like the server cache does (GPS noise must not refetch). */
export const ROUTE_ORIGIN_DECIMALS = 4;
/** A lot has an exact position (6 decimals, ~0.1 m); the contract keeps it exact. */
export const ROUTE_DESTINATION_DECIMALS = 6;

export interface RouteRequest {
  from: LatLng;
  to: LatLng;
}

export interface RoutesApi {
  route(request: RouteRequest, signal?: AbortSignal): Promise<Route>;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Origin precision (4 decimals). */
export function roundRouteCoord(value: number): number {
  return roundTo(value, ROUTE_ORIGIN_DECIMALS);
}

/** Destination precision (6 decimals). */
export function roundDestinationCoord(value: number): number {
  return roundTo(value, ROUTE_DESTINATION_DECIMALS);
}

/** Rounded so the cache key and the request describe exactly the same thing. */
export function routeQueryKey(from: LatLng, to: LatLng): readonly unknown[] {
  return [
    'route',
    'driving',
    roundRouteCoord(from.lat),
    roundRouteCoord(from.lng),
    roundDestinationCoord(to.lat),
    roundDestinationCoord(to.lng),
  ];
}

export function createRoutesApi(client: Pick<AxiosInstance, 'get'>): RoutesApi {
  return {
    async route({ from, to }, signal) {
      // Programmer error, not a network error: never send garbage coordinates.
      if (!isValidLatLng(from) || !isValidLatLng(to)) throw new RangeError('Invalid route coordinates');
      const response = await client.get<unknown>('/routes', {
        params: {
          from_lat: roundRouteCoord(from.lat),
          from_lng: roundRouteCoord(from.lng),
          to_lat: roundDestinationCoord(to.lat),
          to_lng: roundDestinationCoord(to.lng),
          mode: 'driving',
        },
        signal,
      });
      return parseRouteResponse(response.data);
    },
  };
}

/** Authenticated client: Bearer token and 401 -> refresh handling live in `api`. */
export const routesApi: RoutesApi = createRoutesApi(api);
