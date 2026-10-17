import { isValidLatLng, type LatLng } from '@/features/map/geo';
import { sanitizeStreetName } from '@/features/route/instructionText';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^-?\d{1,3}(\.\d{1,10})?$/;

export interface NavigationLot {
  id: string;
  name: string;
  location: LatLng;
}

/** The part of a nearby-cache entry the navigation screen needs. */
export type CachedLot = NavigationLot;

export interface RawLotParams {
  parkingId?: string | string[];
  lat?: string | string[];
  lng?: string | string[];
  name?: string | string[];
}

/** Coordinate text for the in-app link: 6 decimals, plain notation (parseCoord accepts it). */
export function formatCoordParam(value: number): string {
  return value.toFixed(6);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Router params may arrive as string | string[] | undefined. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Plain decimal text within +-limit; anything else (exponents, NaN, units, spaces) is rejected. */
export function parseCoord(value: string | undefined, limit: number): number | null {
  if (value === undefined || !DECIMAL_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
}

export function parseLatLngParams(
  latParam: string | string[] | undefined,
  lngParam: string | string[] | undefined,
): LatLng | null {
  const lat = parseCoord(firstParam(latParam), 90);
  const lng = parseCoord(firstParam(lngParam), 180);
  if (lat === null || lng === null) return null;
  const point = { lat, lng };
  return isValidLatLng(point) ? point : null;
}

/**
 * The destination lot: the nearby cache is authoritative; otherwise the coordinates and name the
 * map passed in the link. Deep-link params are untrusted: coordinates are strictly parsed and the
 * name is sanitized (it is only ever rendered as plain text). null = lot cannot be placed.
 */
export function resolveLot(params: RawLotParams, cached: readonly CachedLot[]): NavigationLot | null {
  const id = firstParam(params.parkingId);
  if (!isUuid(id)) return null;
  const hit = cached.find((lot) => lot.id === id);
  if (hit) return { id, name: sanitizeStreetName(hit.name), location: { ...hit.location } };
  const location = parseLatLngParams(params.lat, params.lng);
  if (location === null) return null;
  return { id, name: sanitizeStreetName(firstParam(params.name) ?? ''), location };
}
