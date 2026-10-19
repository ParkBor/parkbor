import { describe, expect, it } from 'vitest';

import { boundsOfPath, boundsToRegion, pathToLineFeature, regionToBounds, runCamera, toLngLat } from '@/features/map/maplibreAdapter';
import { regionAround } from '@/features/map/search';

describe('toLngLat', () => {
  it('swaps to [lng, lat]', () => {
    expect(toLngLat({ lat: 41.31, lng: 69.28 })).toEqual([69.28, 41.31]);
  });
});

describe('regionToBounds / boundsToRegion', () => {
  it('round-trips a region', () => {
    const region = regionAround({ lat: 41.3111, lng: 69.2797 }, 3000);
    const back = boundsToRegion(regionToBounds(region));
    expect(back?.latitude).toBeCloseTo(region.latitude, 9);
    expect(back?.longitude).toBeCloseTo(region.longitude, 9);
    expect(back?.latitudeDelta).toBeCloseTo(region.latitudeDelta, 9);
    expect(back?.longitudeDelta).toBeCloseTo(region.longitudeDelta, 9);
  });

  it('orders bounds as [west, south, east, north]', () => {
    expect(regionToBounds({ latitude: 10, longitude: 20, latitudeDelta: 2, longitudeDelta: 4 })).toEqual([18, 9, 22, 11]);
  });

  it('never produces an empty box', () => {
    const [west, south, east, north] = regionToBounds({ latitude: 1, longitude: 1, latitudeDelta: 0, longitudeDelta: 0 });
    expect(east).toBeGreaterThan(west);
    expect(north).toBeGreaterThan(south);
  });

  it.each([
    [[1, 2, 3]],
    [[3, 1, 1, 2]],
    [[1, 3, 2, 1]],
    [[Number.NaN, 1, 2, 3]],
    [['a', 1, 2, 3] as unknown as number[]],
    [[]],
  ])('rejects invalid map bounds %j', (bounds) => {
    expect(boundsToRegion(bounds)).toBeNull();
  });
});

describe('boundsOfPath', () => {
  it('covers every point', () => {
    expect(
      boundsOfPath([
        { latitude: 41.3, longitude: 69.2 },
        { latitude: 41.4, longitude: 69.1 },
        { latitude: 41.2, longitude: 69.3 },
      ]),
    ).toEqual([69.1, 41.2, 69.3, 41.4]);
  });

  it('gives a single point some extent', () => {
    const bounds = boundsOfPath([{ latitude: 41.3, longitude: 69.2 }]);
    expect(bounds).not.toBeNull();
    const [west, south, east, north] = bounds ?? [0, 0, 0, 0];
    expect(east).toBeGreaterThan(west);
    expect(north).toBeGreaterThan(south);
  });

  it('ignores non-finite points and returns null for nothing', () => {
    expect(boundsOfPath([])).toBeNull();
    expect(boundsOfPath([{ latitude: Number.NaN, longitude: 1 }])).toBeNull();
    expect(boundsOfPath([{ latitude: Number.NaN, longitude: 1 }, { latitude: 2, longitude: 3 }])).not.toBeNull();
  });
});

describe('pathToLineFeature', () => {
  it('builds a GeoJSON LineString in [lng, lat] order', () => {
    expect(
      pathToLineFeature([
        { latitude: 41.3, longitude: 69.2 },
        { latitude: 41.4, longitude: 69.3 },
      ]),
    ).toEqual({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [69.2, 41.3],
          [69.3, 41.4],
        ],
      },
    });
  });

  it('draws nothing for fewer than two valid points', () => {
    expect(pathToLineFeature([])).toBeNull();
    expect(pathToLineFeature([{ latitude: 1, longitude: 1 }])).toBeNull();
    expect(
      pathToLineFeature([
        { latitude: 1, longitude: 1 },
        { latitude: Number.POSITIVE_INFINITY, longitude: 1 },
      ]),
    ).toBeNull();
  });
});

describe('runCamera', () => {
  it('runs the command', () => {
    let called = 0;
    runCamera(() => (called += 1));
    expect(called).toBe(1);
  });

  it('swallows a synchronous failure (map not ready)', () => {
    expect(() =>
      runCamera(() => {
        throw new Error('NativeCameraComponent ref is null');
      }),
    ).not.toThrow();
  });

  it('swallows a rejected promise without an unhandled rejection', async () => {
    runCamera(() => Promise.reject(new Error('gone')));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
