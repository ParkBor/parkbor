import { describe, expect, it } from 'vitest';

import { DEFAULT_FILTERS } from '@/features/map/filters';
import {
  buildSearchParams,
  nearbyQueryKey,
  regionAround,
  expandedRadius,
  shouldShowSearchHere,
  visibleRadiusM,
} from '@/features/map/search';

const CENTER = { lat: 41.2995, lng: 69.2401 };

describe('visibleRadiusM', () => {
  it('is half of the larger visible span in meters', () => {
    // 0.02 deg latitude ~ 2226 m top to bottom -> ~1113 m radius.
    const r = visibleRadiusM({ latitude: 0, longitude: 0, latitudeDelta: 0.02, longitudeDelta: 0.005 });
    expect(r).toBeGreaterThan(1100);
    expect(r).toBeLessThan(1130);
  });

  it('shrinks the longitude span with latitude', () => {
    const equator = visibleRadiusM({ latitude: 0, longitude: 0, latitudeDelta: 0.001, longitudeDelta: 0.1 });
    const north = visibleRadiusM({ latitude: 60, longitude: 0, latitudeDelta: 0.001, longitudeDelta: 0.1 });
    expect(north).toBeCloseTo(equator / 2, -1);
  });
});

describe('regionAround', () => {
  it('builds a region that shows slightly more than the radius', () => {
    const region = regionAround(CENTER, 3000);
    expect(region.latitude).toBe(CENTER.lat);
    expect(region.longitude).toBe(CENTER.lng);
    expect(visibleRadiusM(region)).toBeGreaterThan(3000);
    expect(visibleRadiusM(region)).toBeLessThan(4000);
  });
});

describe('buildSearchParams', () => {
  it('rounds coordinates to 3 decimals and carries filters', () => {
    const p = buildSearchParams({ lat: 41.29951, lng: 69.24019 }, null, {
      ...DEFAULT_FILTERS,
      slotType: 'EV',
      sort: 'cheapest',
      onlyOpen: true,
    });
    expect(p).toEqual({
      lat: 41.3,
      lng: 69.24,
      radiusM: 3000,
      slotType: 'EV',
      limit: 50,
      sort: 'cheapest',
      onlyOpen: true,
    });
  });

  it('uses the smaller of the visible radius and the filter radius, in 100 m steps', () => {
    expect(buildSearchParams(CENTER, 1234, { ...DEFAULT_FILTERS, radiusM: 5000 }).radiusM).toBe(1200);
    expect(buildSearchParams(CENTER, 9000, { ...DEFAULT_FILTERS, radiusM: 5000 }).radiusM).toBe(5000);
  });

  it('clamps the radius to the backend range 100..10000', () => {
    expect(buildSearchParams(CENTER, 20, DEFAULT_FILTERS).radiusM).toBe(100);
    expect(buildSearchParams(CENTER, null, { ...DEFAULT_FILTERS, radiusM: 50_000 }).radiusM).toBe(10_000);
  });
});

describe('area search from a viewport', () => {
  it('maps a map region to request params (center + visible radius)', () => {
    const region = { latitude: 41.29951, longitude: 69.24019, latitudeDelta: 0.02, longitudeDelta: 0.02 };
    const p = buildSearchParams({ lat: region.latitude, lng: region.longitude }, visibleRadiusM(region), DEFAULT_FILTERS);
    expect(p.lat).toBe(41.3);
    expect(p.lng).toBe(69.24);
    expect(p.radiusM).toBe(1100);
  });
});

describe('expandedRadius', () => {
  it('reports the radius only when the backend widened it', () => {
    expect(expandedRadius(3000, 5000)).toBe(5000);
    expect(expandedRadius(3000, 3000)).toBeNull();
    expect(expandedRadius(3000, null)).toBeNull();
    expect(expandedRadius(3000, 1000)).toBeNull();
  });
});

describe('nearbyQueryKey', () => {
  const base = buildSearchParams(CENTER, null, DEFAULT_FILTERS);

  it('is identical for coordinates that differ below the rounding step', () => {
    const jitter = { ...base, lat: base.lat + 0.0001, lng: base.lng - 0.0002 };
    expect(nearbyQueryKey(jitter)).toEqual(nearbyQueryKey(base));
  });

  it('changes with the area and with every filter', () => {
    const key = JSON.stringify(nearbyQueryKey(base));
    const variants = [
      { ...base, lat: base.lat + 0.01 },
      { ...base, lng: base.lng + 0.01 },
      { ...base, radiusM: 5000 },
      { ...base, slotType: 'EV' as const },
      { ...base, sort: 'nearest' as const },
      { ...base, onlyOpen: true },
    ];
    for (const v of variants) expect(JSON.stringify(nearbyQueryKey(v))).not.toBe(key);
  });

  it('starts with a stable namespace so it can be invalidated as a group', () => {
    expect(nearbyQueryKey(base).slice(0, 2)).toEqual(['parkings', 'nearby']);
  });
});

describe('shouldShowSearchHere', () => {
  const shift = (meters: number) => ({ lat: CENTER.lat + meters / 111_320, lng: CENTER.lng });

  it('stays hidden for small pans', () => {
    expect(shouldShowSearchHere(CENTER, shift(100), 3000)).toBe(false);
    expect(shouldShowSearchHere(CENTER, CENTER, 3000)).toBe(false);
  });

  it('shows once the center moved 25% of the visible radius', () => {
    expect(shouldShowSearchHere(CENTER, shift(700), 3000)).toBe(false);
    expect(shouldShowSearchHere(CENTER, shift(800), 3000)).toBe(true);
  });

  it('never triggers below 500 m even on a tiny viewport', () => {
    expect(shouldShowSearchHere(CENTER, shift(400), 200)).toBe(false);
    expect(shouldShowSearchHere(CENTER, shift(520), 200)).toBe(true);
  });

  it('also shows after zooming out when a wider area would be searched', () => {
    expect(shouldShowSearchHere(CENTER, CENTER, 3000, { searchedM: 1000, nextM: 1200 })).toBe(false);
    expect(shouldShowSearchHere(CENTER, CENTER, 3000, { searchedM: 1000, nextM: 1300 })).toBe(true);
    // Same radius (e.g. capped by the filter): nothing new to find.
    expect(shouldShowSearchHere(CENTER, CENTER, 9000, { searchedM: 3000, nextM: 3000 })).toBe(false);
  });

  it('is false when there is nothing to compare against', () => {
    expect(shouldShowSearchHere(null, shift(5000), 3000)).toBe(false);
  });
});
