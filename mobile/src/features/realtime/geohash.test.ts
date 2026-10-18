import { describe, expect, it } from 'vitest';

import { encodeGeohash, geoCellsAround } from '@/features/realtime/geohash';

const GEOHASH5 = /^[0-9b-hjkmnp-z]{5}$/;
const TASHKENT = { lat: 41.3111, lng: 69.2797 };

describe('encodeGeohash', () => {
  it('matches published reference values', () => {
    expect(encodeGeohash(57.64911, 10.40744, 5)).toBe('u4pru');
    expect(encodeGeohash(42.6, -5.6, 5)).toBe('ezs42');
    expect(encodeGeohash(-25.382708, -49.265506, 5)).toBe('6gkzw');
  });

  it('produces the requested length from the geohash alphabet', () => {
    expect(encodeGeohash(41.3, 69.2, 5)).toMatch(GEOHASH5);
    expect(encodeGeohash(41.3, 69.2, 7)).toHaveLength(7);
  });

  it('keeps the poles and the date line inside the alphabet', () => {
    expect(encodeGeohash(90, 180, 5)).toMatch(GEOHASH5);
    expect(encodeGeohash(-90, -180, 5)).toBe('00000');
  });
});

describe('geoCellsAround', () => {
  it('always contains the cell of the centre', () => {
    const cells = geoCellsAround(TASHKENT, 300);
    expect(cells).toContain(encodeGeohash(TASHKENT.lat, TASHKENT.lng, 5));
    expect(cells.length).toBeGreaterThanOrEqual(1);
    expect(cells.length).toBeLessThanOrEqual(4);
  });

  it('returns valid geohash5 cells without duplicates', () => {
    const cells = geoCellsAround(TASHKENT, 10_000);
    expect(new Set(cells).size).toBe(cells.length);
    for (const cell of cells) expect(cell).toMatch(GEOHASH5);
  });

  it('covers every point of the circle', () => {
    const radiusM = 4000;
    const cells = new Set(geoCellsAround(TASHKENT, radiusM));
    for (let angle = 0; angle < 360; angle += 15) {
      const rad = (angle * Math.PI) / 180;
      const lat = TASHKENT.lat + ((radiusM * Math.cos(rad)) / 111_320) * 0.99;
      const lng = TASHKENT.lng + ((radiusM * Math.sin(rad)) / (111_320 * Math.cos((TASHKENT.lat * Math.PI) / 180))) * 0.99;
      expect(cells.has(encodeGeohash(lat, lng, 5)), `angle ${angle}`).toBe(true);
    }
  });

  it('grows with the radius and is capped, nearest cells first', () => {
    const small = geoCellsAround(TASHKENT, 500);
    const large = geoCellsAround(TASHKENT, 10_000);
    expect(large.length).toBeGreaterThan(small.length);
    const capped = geoCellsAround(TASHKENT, 10_000, 5);
    expect(capped).toHaveLength(5);
    expect(capped[0]).toBe(encodeGeohash(TASHKENT.lat, TASHKENT.lng, 5));
  });

  it('returns nothing for impossible input', () => {
    expect(geoCellsAround({ lat: Number.NaN, lng: 0 }, 100)).toEqual([]);
    expect(geoCellsAround(TASHKENT, -1)).toEqual([]);
    expect(geoCellsAround(TASHKENT, Number.POSITIVE_INFINITY)).toEqual([]);
    expect(geoCellsAround(TASHKENT, 5_000_000)).toEqual([]);
  });

  it('clamps coordinates at the edge of the world', () => {
    for (const cell of geoCellsAround({ lat: 89.99, lng: 179.99 }, 2000)) expect(cell).toMatch(GEOHASH5);
  });
});
