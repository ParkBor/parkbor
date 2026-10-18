const ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';
const METERS_PER_DEGREE_LAT = 111_320;
/** Precision 5 = 25 bits: 13 for longitude, 12 for latitude (cells of ~4.9 km). */
const PRECISION = 5;
const LNG_CELLS = 2 ** 13;
const LAT_CELLS = 2 ** 12;
const CELL_W = 360 / LNG_CELLS;
const CELL_H = 180 / LAT_CELLS;
/** Beyond this many candidate cells the radius is not a lot-search radius at all. */
const MAX_CANDIDATES = 1000;
export const DEFAULT_MAX_CELLS = 30;

/** Standard geohash (base32, longitude first). */
export function encodeGeohash(lat: number, lng: number, precision: number = PRECISION): string {
  let latLow = -90;
  let latHigh = 90;
  let lngLow = -180;
  let lngHigh = 180;
  let hash = '';
  let bit = 0;
  let value = 0;
  let isLng = true;
  while (hash.length < precision) {
    if (isLng) {
      const mid = (lngLow + lngHigh) / 2;
      if (lng >= mid) {
        value = value * 2 + 1;
        lngLow = mid;
      } else {
        value *= 2;
        lngHigh = mid;
      }
    } else {
      const mid = (latLow + latHigh) / 2;
      if (lat >= mid) {
        value = value * 2 + 1;
        latLow = mid;
      } else {
        value *= 2;
        latHigh = mid;
      }
    }
    isLng = !isLng;
    bit += 1;
    if (bit === 5) {
      hash += ALPHABET.charAt(value);
      bit = 0;
      value = 0;
    }
  }
  return hash;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * The geohash5 cells that cover the circle of `radiusM` around `center` (its bounding box, which
 * is what a nearby search shows), nearest cell first and at most `maxCells`. Subscribing to these
 * cells is how the map hears about free-spot changes (`geo_<cell>`). Empty for impossible input.
 */
export function geoCellsAround(
  center: { lat: number; lng: number },
  radiusM: number,
  maxCells: number = DEFAULT_MAX_CELLS,
): string[] {
  if (![center.lat, center.lng, radiusM].every(Number.isFinite) || radiusM < 0) return [];
  const lat = clamp(center.lat, -90, 90);
  const lng = clamp(center.lng, -180, 180);
  const dLat = radiusM / METERS_PER_DEGREE_LAT;
  const dLng = radiusM / (METERS_PER_DEGREE_LAT * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));

  const cellIndex = (value: number, offset: number, size: number, count: number): number =>
    clamp(Math.floor((value + offset) / size), 0, count - 1);
  const latFrom = cellIndex(lat - dLat, 90, CELL_H, LAT_CELLS);
  const latTo = cellIndex(lat + dLat, 90, CELL_H, LAT_CELLS);
  const lngFrom = cellIndex(lng - dLng, 180, CELL_W, LNG_CELLS);
  const lngTo = cellIndex(lng + dLng, 180, CELL_W, LNG_CELLS);
  if ((latTo - latFrom + 1) * (lngTo - lngFrom + 1) > MAX_CANDIDATES) return [];

  const cells: { hash: string; distance: number }[] = [];
  for (let i = latFrom; i <= latTo; i += 1) {
    for (let j = lngFrom; j <= lngTo; j += 1) {
      const cellLat = -90 + (i + 0.5) * CELL_H;
      const cellLng = -180 + (j + 0.5) * CELL_W;
      cells.push({
        hash: encodeGeohash(cellLat, cellLng, PRECISION),
        distance: (cellLat - lat) ** 2 + ((cellLng - lng) * Math.cos((lat * Math.PI) / 180)) ** 2,
      });
    }
  }
  return cells
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, maxCells))
    .map((cell) => cell.hash);
}
