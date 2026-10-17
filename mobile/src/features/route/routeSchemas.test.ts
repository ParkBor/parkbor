import { describe, expect, it } from 'vitest';

import { wireRoute } from '@/features/route/fixtures';
import {
  InvalidRouteResponseError,
  isStepByStep,
  parseRouteResponse,
  toMapPoints,
} from '@/features/route/routeSchemas';

const clone = (value: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(value));
const stepsOf = (body: Record<string, unknown>): Record<string, unknown>[] => body.steps as Record<string, unknown>[];

describe('toMapPoints', () => {
  it('converts GeoJSON [lng, lat] into { latitude, longitude }', () => {
    expect(toMapPoints([[69.27, 41.31]])).toEqual([{ latitude: 41.31, longitude: 69.27 }]);
  });
});

describe('parseRouteResponse', () => {
  it('parses a valid osrm route and keeps lat/lng in the right order', () => {
    const route = parseRouteResponse(wireRoute());
    expect(route.distanceM).toBe(2346);
    expect(route.durationS).toBe(321);
    expect(route.path[0]).toEqual({ latitude: 41.3113, longitude: 69.2743 });
    expect(route.steps[0]).toMatchObject({ key: 'depart', name: 'Amir Temur', distanceM: 100 });
    expect(route.steps[0]?.location).toEqual({ lat: 41.3113, lng: 69.2743 });
    expect(route.source).toBe('osrm');
    expect(route.isApproximate).toBe(false);
    expect(isStepByStep(route)).toBe(true);
  });

  it('marks fallback routes approximate when "approximate" is absent (old backend)', () => {
    const route = parseRouteResponse(wireRoute({ source: 'fallback' }));
    expect(route.isApproximate).toBe(true);
    expect(isStepByStep(route)).toBe(false);
  });

  it('marks osrm routes approximate when the server says so', () => {
    expect(parseRouteResponse(wireRoute({ approximate: true })).isApproximate).toBe(true);
  });

  it('never trusts approximate=false for a non-osrm source', () => {
    const route = parseRouteResponse(wireRoute({ source: 'fallback', approximate: false }));
    expect(route.isApproximate).toBe(true);
  });

  it('treats an unknown source as fallback (approximate) instead of failing', () => {
    const route = parseRouteResponse(wireRoute({ source: 'mapbox' }));
    expect(route.source).toBe('fallback');
    expect(route.isApproximate).toBe(true);
  });

  it('maps an unknown instruction_key to "other"', () => {
    const body = clone(wireRoute());
    stepsOf(body)[0]!.instruction_key = 'teleport';
    expect(parseRouteResponse(body).steps[0]?.key).toBe('other');
  });

  it.each(['fork_left', 'fork_right', 'merge_left', 'merge_right', 'ramp_left', 'ramp_right', 'fork', 'merge', 'ramp'])(
    'accepts instruction_key %s',
    (key) => {
      const body = clone(wireRoute());
      stepsOf(body)[0]!.instruction_key = key;
      expect(parseRouteResponse(body).steps[0]?.key).toBe(key);
    },
  );

  it('reads the roundabout exit and drops an out-of-range one', () => {
    const body = clone(wireRoute());
    const first = stepsOf(body)[0]!;
    first.maneuver = { type: 'roundabout', modifier: 'right', exit: 3 };
    expect(parseRouteResponse(body).steps[0]?.roundaboutExit).toBe(3);
    first.maneuver = { type: 'roundabout', modifier: null, exit: 99 };
    expect(parseRouteResponse(body).steps[0]?.roundaboutExit).toBeNull();
    first.maneuver = { type: 'roundabout', modifier: null, exit: null };
    expect(parseRouteResponse(body).steps[0]?.roundaboutExit).toBeNull();
    first.maneuver = { type: 'roundabout', modifier: null, exit: 0 };
    expect(parseRouteResponse(body).steps[0]?.roundaboutExit).toBeNull();
  });

  const withoutSource = wireRoute();
  delete withoutSource.source;

  it.each([
    ['null', null],
    ['a string', 'route'],
    ['an empty object', {}],
    ['negative distance', wireRoute({ distance_m: -1 })],
    ['fractional distance', wireRoute({ distance_m: 10.5 })],
    ['NaN distance', wireRoute({ distance_m: Number.NaN })],
    ['Infinity duration', wireRoute({ duration_s: Number.POSITIVE_INFINITY })],
    ['absurd distance', wireRoute({ distance_m: 99_000_000 })],
    ['wrong geometry type', wireRoute({ geometry: { type: 'Point', coordinates: [[1, 2]] } })],
    ['one-point geometry', wireRoute({ geometry: { type: 'LineString', coordinates: [[69.2, 41.3]] } })],
    ['lat out of range', wireRoute({ geometry: { type: 'LineString', coordinates: [[69, 41], [69, 91]] } })],
    ['lng out of range', wireRoute({ geometry: { type: 'LineString', coordinates: [[181, 41], [69, 41]] } })],
    ['NaN coordinate', wireRoute({ geometry: { type: 'LineString', coordinates: [[Number.NaN, 41], [69, 41]] } })],
    ['string coordinate', wireRoute({ geometry: { type: 'LineString', coordinates: [['69', 41], [69, 41]] } })],
    ['steps not array', wireRoute({ steps: 'x' })],
    ['missing source', withoutSource],
  ])('rejects %s', (_label, body) => {
    expect(() => parseRouteResponse(body)).toThrow(InvalidRouteResponseError);
  });

  it('rejects a step with out-of-range location', () => {
    const body = clone(wireRoute());
    stepsOf(body)[0]!.location = { lat: 95, lng: 69 };
    expect(() => parseRouteResponse(body)).toThrow(InvalidRouteResponseError);
  });

  it('enforces the geometry size limit (20 000 points)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => [69 + i * 1e-6, 41]);
    const ok = wireRoute({ geometry: { type: 'LineString', coordinates: many(20_000) } });
    expect(parseRouteResponse(ok).path).toHaveLength(20_000);
    const tooMany = wireRoute({ geometry: { type: 'LineString', coordinates: many(20_001) } });
    expect(() => parseRouteResponse(tooMany)).toThrow(InvalidRouteResponseError);
  });

  it('enforces the step limit', () => {
    const base = stepsOf(wireRoute() as Record<string, unknown>)[0]!;
    expect(parseRouteResponse(wireRoute({ steps: Array.from({ length: 500 }, () => base) })).steps).toHaveLength(500);
    expect(() => parseRouteResponse(wireRoute({ steps: Array.from({ length: 601 }, () => base) }))).toThrow(
      InvalidRouteResponseError,
    );
  });

  it('error carries no response content', () => {
    expect.assertions(2);
    try {
      parseRouteResponse({ distance_m: 'secret 41.31,69.27' });
    } catch (error) {
      expect(String(error)).not.toContain('41.31');
      expect((error as Error).name).toBe('InvalidRouteResponseError');
    }
  });
});
