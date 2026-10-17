import { describe, expect, it } from 'vitest';

import { METERS_PER_DEGREE, type LatLng } from '@/features/map/geo';
import { eastRoute, step } from '@/features/route/fixtures';
import {
  ARRIVAL_ALONG_M,
  MAX_PROGRESS_ACCURACY_M,
  computeProgress,
  createProgressTracker,
  distanceToPolylineM,
  fallbackGuidance,
  isTrustedFix,
  prepareRoute,
} from '@/features/route/routeProgress';
import type { Route } from '@/features/route/routeSchemas';

const pt = (lat: number, lng: number) => ({ latitude: lat, longitude: lng });
const at = (p: { latitude: number; longitude: number }): LatLng => ({ lat: p.latitude, lng: p.longitude });

function routeOf(path: ReturnType<typeof pt>[], steps: Route['steps'], over: Partial<Route> = {}): Route {
  return { distanceM: 2000, durationS: 300, path, steps, source: 'osrm', isApproximate: false, ...over };
}

/** Positions every ~step meters along the path (including vertices). */
function walk(path: ReturnType<typeof pt>[], perSegment = 5): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i]!;
    const b = path[i + 1]!;
    for (let k = 0; k < perSegment; k += 1) {
      const f = k / perSegment;
      out.push({ lat: a.latitude + (b.latitude - a.latitude) * f, lng: a.longitude + (b.longitude - a.longitude) * f });
    }
  }
  out.push(at(path[path.length - 1]!));
  return out;
}

describe('antimeridian and far query points', () => {
  const across = [pt(0, 179.999), pt(0, -179.999)];

  it('measures to the nearest endpoint from a point ~10 degrees away (vertices unwrapped sequentially)', () => {
    const d = distanceToPolylineM({ lat: 0, lng: -170 }, across);
    expect(Math.abs(d - 9.999 * METERS_PER_DEGREE)).toBeLessThan(50);
  });

  it('is symmetric for a query on the other side of the antimeridian', () => {
    const d = distanceToPolylineM({ lat: 0, lng: 170 }, across);
    expect(Math.abs(d - 9.999 * METERS_PER_DEGREE)).toBeLessThan(50);
  });

  it('keeps the along-distance consistent for a route crossing the antimeridian', () => {
    const route = routeOf(across, [step({ key: 'depart', location: { lat: 0, lng: 179.999 } })], { distanceM: 222 });
    const p = computeProgress(prepareRoute(route), { lat: 0, lng: 180 });
    expect(p.offRouteM).toBeLessThan(1);
    expect(p.remainingM).toBeGreaterThan(90);
    expect(p.remainingM).toBeLessThan(130);
  });
});

describe('monotonic tracking', () => {
  // Out and back along the same road, with a U-turn step at the far end.
  const outBack = [pt(41.3, 69.2), pt(41.3, 69.21), pt(41.30003, 69.21), pt(41.30003, 69.2)];
  const outBackRoute = routeOf(
    outBack,
    [
      step({ key: 'depart', location: { lat: 41.3, lng: 69.2 } }),
      step({ key: 'uturn', location: { lat: 41.3, lng: 69.21 } }),
      step({ key: 'arrive', location: { lat: 41.30003, lng: 69.2 } }),
    ],
    { distanceM: 1700 },
  );

  it('never moves backwards and does not skip the U-turn on an out-and-back road', () => {
    const tracker = createProgressTracker(prepareRoute(outBackRoute));
    let lastAlong = -1;
    let sawUturnNext = false;
    for (const position of walk(outBack, 20)) {
      const p = tracker.update(position);
      expect(p.alongM).toBeGreaterThanOrEqual(lastAlong - 1);
      lastAlong = p.alongM;
      if (p.nextStep?.step.key === 'uturn') sawUturnNext = true;
    }
    expect(sawUturnNext).toBe(true);
    expect(lastAlong).toBeGreaterThan(1600);
  });

  it('does not report arrival on the way out of an out-and-back route that starts at the destination', () => {
    const tracker = createProgressTracker(prepareRoute(outBackRoute));
    const start = tracker.update({ lat: 41.3, lng: 69.2 });
    expect(start.isArrived).toBe(false);
    const mid = tracker.update({ lat: 41.3, lng: 69.205 });
    expect(mid.isArrived).toBe(false);
    expect(mid.nextStep?.step.key).toBe('uturn');
  });

  // A loop whose last leg ends 11 m from where it started (ramp / overpass shape).
  const loop = [pt(41.3, 69.2), pt(41.3, 69.21), pt(41.31, 69.21), pt(41.31, 69.2), pt(41.3001, 69.2)];
  const loopRoute = routeOf(
    loop,
    [
      step({ key: 'depart', location: { lat: 41.3, lng: 69.2 } }),
      step({ key: 'turn_left', location: { lat: 41.3, lng: 69.21 } }),
      step({ key: 'turn_left', location: { lat: 41.31, lng: 69.21 } }),
      step({ key: 'turn_left', location: { lat: 41.31, lng: 69.2 } }),
      step({ key: 'arrive', location: { lat: 41.3001, lng: 69.2 } }),
    ],
    { distanceM: 3400 },
  );

  it('stays on the last leg of a loop that ends next to its start (tracker) but a fresh global fix is not arrived', () => {
    const index = prepareRoute(loopRoute);
    const tracker = createProgressTracker(index);
    let last = tracker.update({ lat: 41.3, lng: 69.2 });
    expect(last.isArrived).toBe(false);
    for (const position of walk(loop, 10)) last = tracker.update(position);
    // 5 m from the end, closer to the start segment than to the end vertex's own leg.
    last = tracker.update({ lat: 41.30006, lng: 69.20003 });
    expect(last.alongM).toBeGreaterThan(index.totalM - 40);
    expect(last.isArrived).toBe(true);

    const fresh = createProgressTracker(index).update({ lat: 41.30004, lng: 69.2 });
    expect(fresh.alongM).toBeLessThan(40);
    expect(fresh.isArrived).toBe(false);
  });

  it('follows an overpass/ramp that returns 20 m from itself without jumping ahead', () => {
    const ramp = [pt(41.3, 69.2), pt(41.3, 69.206), pt(41.3002, 69.206), pt(41.3002, 69.2), pt(41.3002, 69.19)];
    const route = routeOf(
      ramp,
      [
        step({ key: 'depart', location: { lat: 41.3, lng: 69.2 } }),
        step({ key: 'ramp_left', location: { lat: 41.3, lng: 69.206 } }),
        step({ key: 'arrive', location: { lat: 41.3002, lng: 69.19 } }),
      ],
      { distanceM: 1600 },
    );
    const tracker = createProgressTracker(prepareRoute(route));
    const positions = walk(ramp.slice(0, 2), 12);
    let along = 0;
    for (const position of positions) {
      along = tracker.update(position).alongM;
    }
    // At the end of the first leg the user is ~20 m from the second leg: still on the first.
    expect(along).toBeLessThan(560);
    expect(tracker.update({ lat: 41.30001, lng: 69.206 }).nextStep?.step.key).toBe('ramp_left');
  });

  it('does not arrive early when the route passes a lot on the opposite lane before the U-turn', () => {
    const path = [pt(41.3, 69.2), pt(41.3, 69.205), pt(41.3002, 69.205), pt(41.3002, 69.2025)];
    const route = routeOf(
      path,
      [
        step({ key: 'depart', location: { lat: 41.3, lng: 69.2 } }),
        step({ key: 'uturn', location: { lat: 41.3, lng: 69.205 } }),
        step({ key: 'arrive', location: { lat: 41.3002, lng: 69.2025 } }),
      ],
      { distanceM: 650 },
    );
    const tracker = createProgressTracker(prepareRoute(route));
    let p = tracker.update({ lat: 41.3, lng: 69.2 });
    for (const position of walk([path[0]!, pt(41.3, 69.2025)], 25)) p = tracker.update(position);
    // Abreast of the lot (22 m across the road) on the way out.
    expect(p.isArrived).toBe(false);
    expect(p.nextStep?.step.key).toBe('uturn');
    // Drive on, U-turn, and come back to the lot.
    for (const position of walk([pt(41.3, 69.2025), ...path.slice(1)], 10)) p = tracker.update(position);
    expect(p.isArrived).toBe(true);
    expect(ARRIVAL_ALONG_M).toBeGreaterThan(0);
  });

  it('falls back to a global search when the windowed match is far from the line', () => {
    const route = eastRoute();
    const tracker = createProgressTracker(prepareRoute(route));
    tracker.update({ lat: 41.3, lng: 69.2 });
    // GPS teleports to the end of the route (>500 m ahead): the window cannot explain it.
    const p = tracker.update({ lat: 41.3, lng: 69.2199 });
    expect(p.alongM).toBeGreaterThan(1500);
  });

  it('returns the same Progress object for the same position (memo friendly)', () => {
    const tracker = createProgressTracker(prepareRoute(eastRoute()));
    const position = { lat: 41.3, lng: 69.205 };
    expect(tracker.update(position)).toBe(tracker.update(position));
  });
});

describe('prepareRoute performance and ordering', () => {
  it('handles 20 000 vertices and 600 steps with ordered, finite step positions', () => {
    const n = 20_000;
    const path = Array.from({ length: n }, (_, i) => pt(41.3, 69.2 + i * 0.00002));
    const steps = Array.from({ length: 600 }, (_, i) =>
      step({
        key: i === 599 ? 'arrive' : 'straight',
        distanceM: 12,
        location: { lat: 41.3, lng: 69.2 + (i * (n - 1) * 0.00002) / 599 },
      }),
    );
    const started = Date.now();
    const index = prepareRoute(routeOf(path, steps, { distanceM: 6000 }));
    expect(Date.now() - started).toBeLessThan(3000);
    for (let i = 1; i < index.stepAlongM.length; i += 1) {
      expect(Number.isFinite(index.stepAlongM[i])).toBe(true);
      expect(index.stepAlongM[i]!).toBeGreaterThanOrEqual(index.stepAlongM[i - 1]!);
    }
  });
});

describe('fix trust and fallback arrival', () => {
  it('trusts only accurate fixes for step/arrival decisions', () => {
    expect(isTrustedFix(5)).toBe(true);
    expect(isTrustedFix(MAX_PROGRESS_ACCURACY_M)).toBe(true);
    expect(isTrustedFix(MAX_PROGRESS_ACCURACY_M + 1)).toBe(false);
    expect(isTrustedFix(null)).toBe(false);
    expect(isTrustedFix(Number.NaN)).toBe(false);
  });

  it('detects arrival within 30 m on a straight-line (approximate) route', () => {
    const route = eastRoute({ source: 'fallback', isApproximate: true });
    const dest = { lat: 41.3, lng: 69.22 };
    expect(fallbackGuidance({ lat: 41.3, lng: 69.2199 }, dest, route).isArrived).toBe(true);
    expect(fallbackGuidance({ lat: 41.3, lng: 69.2190 }, dest, route).isArrived).toBe(false);
  });
});
