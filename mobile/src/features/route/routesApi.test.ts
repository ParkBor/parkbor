import { describe, expect, it, vi } from 'vitest';

import { wireRoute } from '@/features/route/fixtures';
import {
  createRoutesApi,
  roundRouteCoord,
  roundDestinationCoord,
  routeQueryKey,
} from '@/features/route/routesApi';
import { InvalidRouteResponseError } from '@/features/route/routeSchemas';

// Importing routesApi pulls in the real auth client; replace it (vi.mock is hoisted).
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

const from = { lat: 41.31134, lng: 69.27436 };
// A lot has an exact 6-decimal position (contract): it must not be flattened to ~11 m.
const to = { lat: 41.326512, lng: 69.228534 };

describe('createRoutesApi', () => {
  it('rounds the origin to 4 decimals but keeps the destination at 6', async () => {
    const get = vi.fn().mockResolvedValue({ data: wireRoute() });
    const signal = new AbortController().signal;
    const route = await createRoutesApi({ get }).route({ from, to }, signal);
    expect(get).toHaveBeenCalledWith('/routes', {
      params: { from_lat: 41.3113, from_lng: 69.2744, to_lat: 41.326512, to_lng: 69.228534, mode: 'driving' },
      signal,
    });
    expect(route.source).toBe('osrm');
  });

  it('sends different destination params for lots that differ only at the 5th-6th decimal', async () => {
    const get = vi.fn().mockResolvedValue({ data: wireRoute() });
    const api = createRoutesApi({ get });
    await api.route({ from, to });
    await api.route({ from, to: { lat: 41.326549, lng: 69.228534 } });
    const sent = get.mock.calls.map((call) => (call[1] as { params: { to_lat: number } }).params.to_lat);
    expect(sent).toEqual([41.326512, 41.326549]);
  });

  it('rejects a malformed body with InvalidRouteResponseError', async () => {
    const get = vi.fn().mockResolvedValue({ data: { nope: true } });
    await expect(createRoutesApi({ get }).route({ from, to })).rejects.toBeInstanceOf(InvalidRouteResponseError);
  });

  it('propagates transport errors untouched', async () => {
    const boom = new Error('network');
    const get = vi.fn().mockRejectedValue(boom);
    await expect(createRoutesApi({ get }).route({ from, to })).rejects.toBe(boom);
  });

  it.each([
    ['NaN lat', { lat: Number.NaN, lng: 69 }],
    ['lat > 90', { lat: 91, lng: 69 }],
    ['lng < -180', { lat: 41, lng: -181 }],
    ['Infinity', { lat: 41, lng: Number.POSITIVE_INFINITY }],
  ])('does not call the network for an invalid origin (%s)', async (_label, bad) => {
    const get = vi.fn();
    await expect(createRoutesApi({ get }).route({ from: bad, to })).rejects.toBeInstanceOf(RangeError);
    expect(get).not.toHaveBeenCalled();
  });

  it('does not call the network for an invalid destination', async () => {
    const get = vi.fn();
    await expect(createRoutesApi({ get }).route({ from, to: { lat: 95, lng: 69 } })).rejects.toBeInstanceOf(RangeError);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('routeQueryKey', () => {
  it('rounds the origin to 4 decimals so nearby points share a cache entry', () => {
    expect(roundRouteCoord(41.31134)).toBe(41.3113);
    expect(routeQueryKey(from, to)).toEqual(routeQueryKey({ lat: 41.31131, lng: 69.27441 }, to));
    expect(routeQueryKey(from, to)).not.toEqual(routeQueryKey({ lat: 41.3125, lng: 69.2744 }, to));
  });

  it('keeps 6 decimals for the destination: two lots 5-6 decimals apart get separate keys', () => {
    expect(roundDestinationCoord(41.3265124)).toBe(41.326512);
    const other = { lat: 41.326549, lng: 69.228534 };
    expect(routeQueryKey(from, to)).not.toEqual(routeQueryKey(from, other));
    expect(routeQueryKey(from, to)).toEqual(routeQueryKey(from, { lat: 41.3265121, lng: 69.2285341 }));
  });
});
