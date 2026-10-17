// Test helpers shared by the route tests (not imported by app code).
import type { Route, RouteStep } from '@/features/route/routeSchemas';

export function wireRoute(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    distance_m: 2346,
    duration_s: 321,
    geometry: {
      type: 'LineString',
      coordinates: [
        [69.2743, 41.3113],
        [69.2801, 41.3141],
      ],
    },
    steps: [
      {
        instruction_key: 'depart',
        name: 'Amir Temur',
        distance_m: 100,
        duration_s: 20,
        location: { lat: 41.3113, lng: 69.2743 },
        maneuver: { type: 'depart', modifier: null },
      },
      {
        instruction_key: 'arrive',
        name: '',
        distance_m: 0,
        duration_s: 0,
        location: { lat: 41.3141, lng: 69.2801 },
        maneuver: { type: 'arrive', modifier: null },
      },
    ],
    source: 'osrm',
    ...over,
  };
}

export function step(over: Partial<RouteStep> = {}): RouteStep {
  return {
    key: 'turn_left',
    name: '',
    distanceM: 0,
    durationS: 0,
    location: { lat: 0, lng: 0 },
    roundaboutExit: null,
    ...over,
  };
}

/** A straight west-east route at lat 41.3 from lng 69.2 to 69.22 (~1.67 km) with three steps. */
export function eastRoute(over: Partial<Route> = {}): Route {
  const path = [
    { latitude: 41.3, longitude: 69.2 },
    { latitude: 41.3, longitude: 69.21 },
    { latitude: 41.3, longitude: 69.22 },
  ];
  return {
    distanceM: 1670,
    durationS: 200,
    path,
    steps: [
      step({ key: 'depart', location: { lat: 41.3, lng: 69.2 } }),
      step({ key: 'turn_left', name: 'Navoi', location: { lat: 41.3, lng: 69.21 } }),
      step({ key: 'arrive', location: { lat: 41.3, lng: 69.22 } }),
    ],
    source: 'osrm',
    isApproximate: false,
    ...over,
  };
}
