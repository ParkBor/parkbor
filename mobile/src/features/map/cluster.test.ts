import { describe, expect, it } from 'vitest';

import {
  buildClusterIndex,
  clusterExpansionRegion,
  getMapItems,
  regionToZoom,
} from '@/features/map/cluster';
import type { Parking } from '@/features/map/schemas';

function lot(id: string, lat: number, lng: number, over: Partial<Parking> = {}): Parking {
  return {
    id,
    name: id,
    address: '',
    location: { lat, lng },
    distanceM: 0,
    durationS: null,
    freeSlots: 5,
    totalSlots: 10,
    pricePerHour: null,
    rating: null,
    isOpen: true,
    score: null,
    ...over,
  };
}

const CITY = { latitude: 41.3, longitude: 69.24, latitudeDelta: 0.2, longitudeDelta: 0.2 };
const STREET = { latitude: 41.3, longitude: 69.24, latitudeDelta: 0.0005, longitudeDelta: 0.0005 };

describe('regionToZoom', () => {
  it('maps longitude delta to a zoom level', () => {
    expect(regionToZoom(360)).toBe(0);
    expect(regionToZoom(180)).toBe(1);
    expect(regionToZoom(0.2)).toBe(10);
  });

  it('is clamped to 0..20', () => {
    expect(regionToZoom(0)).toBe(20);
    expect(regionToZoom(10_000)).toBe(0);
  });
});

describe('getMapItems', () => {
  const near = [lot('a', 41.3, 69.24), lot('b', 41.3001, 69.2401)];

  it('merges nearby lots into one cluster when zoomed out', () => {
    const items = getMapItems(buildClusterIndex(near), CITY);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'cluster', count: 2, free: 10, total: 20, kind: 'green' });
  });

  it('shows individual lots when zoomed in', () => {
    const items = getMapItems(buildClusterIndex(near), STREET);
    expect(items.map((i) => i.type)).toEqual(['parking', 'parking']);
  });

  it('keeps distant lots separate', () => {
    const far = [lot('a', 41.3, 69.24), lot('b', 41.38, 69.31)];
    expect(getMapItems(buildClusterIndex(far), CITY)).toHaveLength(2);
  });

  it('colors a cluster from the open lots only', () => {
    const mixed = [
      lot('a', 41.3, 69.24, { freeSlots: 1, totalSlots: 10 }),
      lot('b', 41.3001, 69.2401, { freeSlots: 40, totalSlots: 40, isOpen: false }),
    ];
    const [cluster] = getMapItems(buildClusterIndex(mixed), CITY);
    expect(cluster).toMatchObject({ type: 'cluster', count: 2, free: 1, total: 10, kind: 'yellow' });
  });

  it('makes a cluster gray when every lot is closed', () => {
    const closed = [lot('a', 41.3, 69.24, { isOpen: false }), lot('b', 41.3001, 69.2401, { isOpen: false })];
    const [cluster] = getMapItems(buildClusterIndex(closed), CITY);
    expect(cluster).toMatchObject({ type: 'cluster', free: 0, kind: 'gray' });
  });

  it('only returns what is inside the viewport', () => {
    const lots = [lot('in', 41.3, 69.24), lot('out', 40.0, 68.0)];
    const items = getMapItems(buildClusterIndex(lots), CITY);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'parking' });
  });

  it('handles an empty list', () => {
    expect(getMapItems(buildClusterIndex([]), CITY)).toEqual([]);
  });
});

describe('clusterExpansionRegion', () => {
  it('zooms in on the cluster center', () => {
    const index = buildClusterIndex([lot('a', 41.3, 69.24), lot('b', 41.3001, 69.2401)]);
    const [cluster] = getMapItems(index, CITY);
    if (cluster?.type !== 'cluster') throw new Error('expected a cluster');
    const target = clusterExpansionRegion(index, cluster.id, { latitude: cluster.lat, longitude: cluster.lng });
    expect(target.latitude).toBeCloseTo(41.30005, 3);
    expect(target.longitudeDelta).toBeLessThan(CITY.longitudeDelta);
    expect(target.longitudeDelta).toBeGreaterThan(0);
  });
});
