import { describe, expect, it } from 'vitest';

import { eastRoute, step } from '@/features/route/fixtures';
import {
  ARRIVAL_RADIUS_M,
  bearingDeg,
  cardinalOf,
  computeProgress,
  distanceToPolylineM,
  fallbackGuidance,
  maneuverProximity,
  prepareRoute,
} from '@/features/route/routeProgress';

const M_PER_DEG = 111_195;

describe('distanceToPolylineM', () => {
  const line = [
    { latitude: 41.3, longitude: 69.2 },
    { latitude: 41.3, longitude: 69.21 },
  ];

  it('is ~0 on the line and the perpendicular distance beside it', () => {
    expect(distanceToPolylineM({ lat: 41.3, lng: 69.205 }, line)).toBeLessThan(0.5);
    // 0.0005 deg of latitude north of the middle of the segment ~ 55.6 m.
    expect(distanceToPolylineM({ lat: 41.3005, lng: 69.205 }, line)).toBeCloseTo(0.0005 * M_PER_DEG, 0);
  });

  it('measures to the nearest endpoint beyond a segment end', () => {
    // 0.001 deg of longitude past the end at lat 41.3 ~ 83.5 m.
    const expected = 0.001 * Math.cos((41.3 * Math.PI) / 180) * M_PER_DEG;
    expect(distanceToPolylineM({ lat: 41.3, lng: 69.211 }, line)).toBeCloseTo(expected, 0);
  });

  it('picks the nearest segment of a multi-segment line', () => {
    const bent = [...line, { latitude: 41.31, longitude: 69.21 }];
    expect(distanceToPolylineM({ lat: 41.305, lng: 69.2101 }, bent)).toBeLessThan(10);
  });

  it('handles a zero-length segment and a single-point line', () => {
    const dup = [line[0]!, line[0]!];
    const expected = 0.0005 * M_PER_DEG;
    expect(distanceToPolylineM({ lat: 41.3005, lng: 69.2 }, dup)).toBeCloseTo(expected, 0);
    expect(distanceToPolylineM({ lat: 41.3005, lng: 69.2 }, [line[0]!])).toBeCloseTo(expected, 0);
  });

  it('works for a long (50 km) segment', () => {
    const long = [
      { latitude: 41.3, longitude: 69.0 },
      { latitude: 41.3, longitude: 69.6 },
    ];
    expect(distanceToPolylineM({ lat: 41.3, lng: 69.3 }, long)).toBeLessThan(1);
    expect(distanceToPolylineM({ lat: 41.3009, lng: 69.3 }, long)).toBeCloseTo(0.0009 * M_PER_DEG, 0);
  });

  it('wraps the antimeridian', () => {
    const across = [
      { latitude: 0, longitude: 179.999 },
      { latitude: 0, longitude: -179.999 },
    ];
    expect(distanceToPolylineM({ lat: 0, lng: 180 }, across)).toBeLessThan(0.5);
    expect(distanceToPolylineM({ lat: 0.0005, lng: -179.9995 }, across)).toBeCloseTo(0.0005 * M_PER_DEG, 0);
  });

  it('returns Infinity for an empty line', () => {
    expect(distanceToPolylineM({ lat: 41, lng: 69 }, [])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('computeProgress', () => {
  const index = prepareRoute(eastRoute());
  const at = (lngDelta: number, latDelta = 0) => ({ lat: 41.3 + latDelta, lng: 69.2 + lngDelta });

  it('reports remaining distance/time proportionally and the next maneuver', () => {
    const progress = computeProgress(index, at(0.005)); // ~ 0.25 of the route
    expect(progress.offRouteM).toBeLessThan(1);
    expect(progress.remainingM).toBeGreaterThan(1670 * 0.7);
    expect(progress.remainingM).toBeLessThan(1670 * 0.8);
    expect(progress.remainingS).toBeGreaterThan(140);
    expect(progress.remainingS).toBeLessThan(160);
    expect(progress.nextStep?.step.key).toBe('turn_left');
    // ~ 0.005 deg of lng at lat 41.3 ~ 417 m
    expect(progress.nextStep?.distanceM).toBeGreaterThan(410);
    expect(progress.nextStep?.distanceM).toBeLessThan(425);
    expect(progress.isArrived).toBe(false);
  });

  it('skips depart and advances to arrive after the maneuver is passed', () => {
    const progress = computeProgress(index, at(0.0125)); // past the turn at 0.01
    expect(progress.nextStep?.step.key).toBe('arrive');
  });

  it('still points to the maneuver while within the GPS passing margin', () => {
    const progress = computeProgress(index, at(0.01 + 0.00005)); // ~4 m past the turn
    expect(progress.nextStep?.step.key).toBe('turn_left');
    expect(progress.nextStep?.distanceM).toBe(0);
  });

  it('measures off-route distance when leaving the line', () => {
    const progress = computeProgress(index, at(0.005, 0.001));
    expect(progress.offRouteM).toBeGreaterThan(105);
    expect(progress.offRouteM).toBeLessThan(115);
  });

  it('detects arrival near the end of the route', () => {
    expect(computeProgress(index, at(0.02 - 0.0001)).isArrived).toBe(true);
    expect(ARRIVAL_RADIUS_M).toBeGreaterThan(0);
  });

  it('clamps remaining at the full route before the start and at 0 beyond the end', () => {
    expect(computeProgress(index, at(-0.01)).remainingM).toBe(1670);
    expect(computeProgress(index, at(0.03)).remainingM).toBe(0);
  });

  it('keeps steps ordered along the line even if the step list has a location off the line', () => {
    const odd = prepareRoute(
      eastRoute({
        steps: [
          step({ key: 'depart', location: { lat: 41.3, lng: 69.2 } }),
          step({ key: 'turn_right', location: { lat: 41.3002, lng: 69.215 } }),
          step({ key: 'arrive', location: { lat: 41.3, lng: 69.22 } }),
        ],
      }),
    );
    expect(computeProgress(odd, at(0.001)).nextStep?.step.key).toBe('turn_right');
  });

  it('survives a route with no steps and a zero-length geometry', () => {
    const empty = prepareRoute(eastRoute({ steps: [] }));
    expect(computeProgress(empty, at(0.005)).nextStep).toBeNull();
    const zero = prepareRoute(
      eastRoute({ path: [{ latitude: 41.3, longitude: 69.2 }, { latitude: 41.3, longitude: 69.2 }], steps: [] }),
    );
    const progress = computeProgress(zero, at(0.002)); // ~140 m away from the degenerate line
    expect(progress.remainingM).toBe(1670);
    expect(computeProgress(zero, at(0)).isArrived).toBe(true);
    expect(Number.isFinite(progress.offRouteM)).toBe(true);
  });
});

describe('maneuverProximity', () => {
  it.each([
    [0, 'now'],
    [30, 'now'],
    [31, 'soon'],
    [150, 'soon'],
    [151, 'far'],
    [5000, 'far'],
  ])('%d m is %s', (meters, expected) => {
    expect(maneuverProximity(meters)).toBe(expected);
  });
});

describe('fallback guidance', () => {
  const dest = { lat: 41.3, lng: 69.21 };

  it('gives straight-line distance, bearing and cardinal direction', () => {
    const g = fallbackGuidance({ lat: 41.3, lng: 69.2 }, dest, eastRoute({ source: 'fallback', isApproximate: true }));
    expect(g.distanceM).toBeGreaterThan(830);
    expect(g.distanceM).toBeLessThan(840);
    expect(g.bearingDeg).toBeCloseTo(90, 0);
    expect(g.cardinal).toBe('e');
    expect(g.remainingS).toBeGreaterThan(0);
    expect(g.remainingS).toBeLessThan(200);
  });
});

describe('bearing and cardinal', () => {
  it('computes compass bearings', () => {
    const o = { lat: 41, lng: 69 };
    expect(bearingDeg(o, { lat: 42, lng: 69 })).toBeCloseTo(0, 3);
    expect(bearingDeg(o, { lat: 40, lng: 69 })).toBeCloseTo(180, 3);
    expect(bearingDeg(o, { lat: 41, lng: 70 })).toBeGreaterThan(89);
    expect(bearingDeg(o, { lat: 41, lng: 68 })).toBeGreaterThan(269);
  });

  it.each([
    [0, 'n'],
    [44, 'ne'],
    [90, 'e'],
    [135, 'se'],
    [180, 's'],
    [225, 'sw'],
    [270, 'w'],
    [315, 'nw'],
    [359, 'n'],
  ])('%d degrees is %s', (deg, expected) => {
    expect(cardinalOf(deg)).toBe(expected);
  });
});
