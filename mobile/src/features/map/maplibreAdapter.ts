import type { LatLng, Region } from '@/features/map/geo';

// Pure conversions between the app's own viewport/point types (Region, LatLng, MapPoint - what the
// clustering, search and routing logic use) and what MapLibre wants. MapLibre uses [lng, lat]
// pairs and [west, south, east, north] bounds. Nothing here imports the native module.

export type LngLat = [longitude: number, latitude: number];
export type LngLatBounds = [west: number, south: number, east: number, north: number];

const MIN_SPAN_DEG = 1e-5;

export function toLngLat(point: LatLng): LngLat {
  return [point.lng, point.lat];
}

export function regionToBounds(region: Region): LngLatBounds {
  const halfLat = Math.max(region.latitudeDelta, MIN_SPAN_DEG) / 2;
  const halfLng = Math.max(region.longitudeDelta, MIN_SPAN_DEG) / 2;
  return [region.longitude - halfLng, region.latitude - halfLat, region.longitude + halfLng, region.latitude + halfLat];
}

/** The settled viewport of the map as a Region (bounds -> centre + deltas). */
export function boundsToRegion(bounds: readonly number[]): Region | null {
  const [west, south, east, north] = bounds;
  if (![west, south, east, north].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (west === undefined || south === undefined || east === undefined || north === undefined) return null;
  if (north <= south || east <= west) return null;
  return {
    latitude: (south + north) / 2,
    longitude: (west + east) / 2,
    latitudeDelta: north - south,
    longitudeDelta: east - west,
  };
}

interface PathPoint {
  latitude: number;
  longitude: number;
}

/** Bounding box of a path, or null for an empty one. */
export function boundsOfPath(path: readonly PathPoint[]): LngLatBounds | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const { latitude, longitude } of path) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  if (!Number.isFinite(west)) return null;
  // A single point (or a straight N-S / E-W line) still needs some extent to frame.
  if (east - west < MIN_SPAN_DEG) {
    west -= MIN_SPAN_DEG;
    east += MIN_SPAN_DEG;
  }
  if (north - south < MIN_SPAN_DEG) {
    south -= MIN_SPAN_DEG;
    north += MIN_SPAN_DEG;
  }
  return [west, south, east, north];
}

export interface LineFeature {
  type: 'Feature';
  properties: Record<string, never>;
  geometry: { type: 'LineString'; coordinates: LngLat[] };
}

/** GeoJSON line for a route; null when there is nothing to draw (fewer than two valid points). */
export function pathToLineFeature(path: readonly PathPoint[]): LineFeature | null {
  const coordinates: LngLat[] = [];
  for (const { latitude, longitude } of path) {
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) coordinates.push([longitude, latitude]);
  }
  if (coordinates.length < 2) return null;
  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } };
}

/**
 * Camera commands fail (synchronously or as a rejected promise) while the native map is not
 * initialised yet or already gone. A missed animation is harmless, so it must not crash a screen.
 */
export function runCamera(command: () => unknown): void {
  try {
    const result = command();
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // the map is not ready: the next command will work
  }
}
