import { haversineM, METERS_PER_DEGREE, type LatLng } from '@/features/map/geo';
import type { MapPoint, Route, RouteStep } from '@/features/route/routeSchemas';

/** Within this distance of the final point the trip may count as arrived... */
export const ARRIVAL_RADIUS_M = 30;
/** ...but only if the user is also this close to the END of the line (not a mid-route pass). */
export const ARRIVAL_ALONG_M = 40;
/** A fix less accurate than this is shown but never drives next-step / arrival decisions. */
export const MAX_PROGRESS_ACCURACY_M = 100;
/** A maneuver is "passed" only this far beyond it (GPS jitter must not skip a turn). */
const PASSED_MARGIN_M = 10;
const NOW_M = 30;
const SOON_M = 150;
const SECONDS_PER_HOUR = 3600;
const FALLBACK_SPEED_MPS = 30_000 / SECONDS_PER_HOUR;

/** Tracking window: a few segments back, a few hundred meters ahead of the last match. */
const WINDOW_BACK_SEGMENTS = 3;
const WINDOW_BACK_M = 30;
const WINDOW_FORWARD_M = 500;
/** A windowed match farther than this from the line is not trusted: search the whole line. */
const WINDOW_ACCEPT_M = 50;
/** Step positions: search near the previous step first (its length tells where to look). */
const STEP_REACH_FACTOR = 1.5;
const STEP_REACH_EXTRA_M = 300;
const STEP_ACCEPT_M = 60;

export type Cardinal = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export type Proximity = 'now' | 'soon' | 'far';

export function isTrustedFix(accuracyM: number | null): boolean {
  return accuracyM !== null && Number.isFinite(accuracyM) && accuracyM <= MAX_PROGRESS_ACCURACY_M;
}

interface Projection {
  distanceM: number;
  /** Index of the segment the point projects onto. */
  segment: number;
  /** 0..1 position along that segment. */
  t: number;
}

/** Vertices with longitudes unwrapped one after another, so no segment ever jumps the globe. */
interface Geometry {
  lat: Float64Array;
  ulng: Float64Array;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function alongAt(cumulativeM: readonly number[], segment: number, t: number): number {
  const start = cumulativeM[segment] ?? 0;
  const end = cumulativeM[segment + 1] ?? start;
  return start + (end - start) * t;
}

function wrapDeg(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

function buildGeometry(path: readonly MapPoint[]): Geometry {
  const lat = new Float64Array(path.length);
  const ulng = new Float64Array(path.length);
  for (let i = 0; i < path.length; i += 1) {
    const p = path[i]!;
    lat[i] = p.latitude;
    ulng[i] = i === 0 ? p.longitude : ulng[i - 1]! + wrapDeg(p.longitude - ulng[i - 1]!);
  }
  return { lat, ulng };
}

/**
 * Nearest point of segments [from, to) of the polyline. Method of the backend's
 * apps.core.geomath.distance_to_polyline_m: vertices are projected onto a local equirectangular
 * plane centred on the query point and the minimum point-to-segment distance wins; zero-length
 * segments degrade to the point distance. Unlike the backend, longitudes are unwrapped from
 * vertex to vertex (not each wrapped alone), so antimeridian-crossing and very long segments
 * take the short way. No allocation per call: the geometry is built once per route.
 */
function nearestInRange(
  geo: Geometry,
  point: LatLng,
  from: number,
  to: number,
  /** Tracking: ignore matches that lie more than this far BEHIND the last match. */
  floor?: { cumulativeM: readonly number[]; minAlongM: number },
): Projection {
  const n = geo.lat.length;
  if (n === 0) return { distanceM: Number.POSITIVE_INFINITY, segment: 0, t: 0 };
  const cosLat = Math.cos(toRad(point.lat));
  const anchor = wrapDeg(geo.ulng[0]! - point.lng) - geo.ulng[0]!;
  const xOf = (i: number): number => (geo.ulng[i]! + anchor) * cosLat * METERS_PER_DEGREE;
  const yOf = (i: number): number => (geo.lat[i]! - point.lat) * METERS_PER_DEGREE;
  if (n === 1) return { distanceM: Math.hypot(xOf(0), yOf(0)), segment: 0, t: 0 };

  const last = Math.min(to, n - 1);
  let best: Projection = { distanceM: Number.POSITIVE_INFINITY, segment: Math.max(0, from), t: 0 };
  let ax = xOf(Math.max(0, from));
  let ay = yOf(Math.max(0, from));
  for (let i = Math.max(0, from); i < last; i += 1) {
    const bx = xOf(i + 1);
    const by = yOf(i + 1);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best.distanceM && (floor === undefined || alongAt(floor.cumulativeM, i, t) >= floor.minAlongM)) {
      best = { distanceM: d, segment: i, t };
    }
    ax = bx;
    ay = by;
  }
  return best;
}

/** Shortest distance in meters from a point to a polyline (rerouting check, ARCH 10.2). */
export function distanceToPolylineM(point: LatLng, path: readonly MapPoint[]): number {
  const geo = buildGeometry(path);
  return nearestInRange(geo, point, 0, geo.lat.length - 1).distanceM;
}

const toLatLng = (p: MapPoint): LatLng => ({ lat: p.latitude, lng: p.longitude });

export interface RouteIndex {
  route: Route;
  geo: Geometry;
  /** Distance along the polyline at each vertex. */
  cumulativeM: number[];
  totalM: number;
  /** Distance along the polyline of each step's maneuver (monotonic non-decreasing). */
  stepAlongM: number[];
}

function alongOf(cumulativeM: readonly number[], p: Projection): number {
  const start = cumulativeM[p.segment] ?? 0;
  const end = cumulativeM[p.segment + 1] ?? start;
  return start + (end - start) * p.t;
}

/** Last segment index whose start is at or before `distanceM` along the line. */
function segmentAtDistance(cumulativeM: readonly number[], distanceM: number): number {
  let lo = 0;
  let hi = Math.max(0, cumulativeM.length - 2);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((cumulativeM[mid] ?? 0) <= distanceM) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Precomputes geometry, lengths and where each step lies on the line. Call once per route. */
export function prepareRoute(route: Route): RouteIndex {
  const geo = buildGeometry(route.path);
  const cumulativeM: number[] = [0];
  for (let i = 1; i < route.path.length; i += 1) {
    const prev = cumulativeM[i - 1] ?? 0;
    cumulativeM.push(prev + haversineM(toLatLng(route.path[i - 1]!), toLatLng(route.path[i]!)));
  }
  const totalM = cumulativeM[cumulativeM.length - 1] ?? 0;
  const segmentCount = Math.max(1, geo.lat.length - 1);

  // Steps follow the route: each one is searched from the previous step's segment onwards, in
  // a window sized by the previous step's length, so a road that doubles back over itself cannot
  // send a later step to an earlier stretch, and the work stays linear.
  let segment = 0;
  let previousAlong = 0;
  const stepAlongM = route.steps.map((step, i) => {
    if (step.key === 'arrive') return totalM;
    const reach = previousAlong + (route.steps[i - 1]?.distanceM ?? 0) * STEP_REACH_FACTOR + STEP_REACH_EXTRA_M;
    const windowEnd = segmentAtDistance(cumulativeM, reach) + 1;
    let projection = nearestInRange(geo, step.location, segment, windowEnd);
    if (projection.distanceM > STEP_ACCEPT_M) projection = nearestInRange(geo, step.location, segment, segmentCount);
    segment = projection.segment;
    previousAlong = Math.max(previousAlong, alongOf(cumulativeM, projection));
    return previousAlong;
  });
  return { route, geo, cumulativeM, totalM, stepAlongM };
}

export interface NextStep {
  step: RouteStep;
  index: number;
  /** Meters along the route until the maneuver. */
  distanceM: number;
}

export interface Progress {
  offRouteM: number;
  alongM: number;
  /** Matched segment: feed it back as the hint of the next fix. */
  segment: number;
  remainingM: number;
  remainingS: number;
  nextStep: NextStep | null;
  isArrived: boolean;
}

function findNextStep(index: RouteIndex, alongM: number): NextStep | null {
  for (let i = 0; i < index.route.steps.length; i += 1) {
    const step = index.route.steps[i]!;
    if (step.key === 'depart') continue;
    const stepAlong = index.stepAlongM[i] ?? 0;
    if (stepAlong < alongM - PASSED_MARGIN_M) continue;
    return { step, index: i, distanceM: Math.max(0, stepAlong - alongM) };
  }
  return null;
}

/** Window around the previous match; falls back to the whole line when nothing fits nearby. */
function locate(index: RouteIndex, position: LatLng, hintOrNull: ProgressHint | null): Projection {
  const { geo, cumulativeM } = index;
  const segmentCount = Math.max(1, geo.lat.length - 1);
  if (hintOrNull === null) return nearestInRange(geo, position, 0, segmentCount);
  const hint = Math.min(Math.max(0, hintOrNull.segment), segmentCount - 1);
  let start = hint;
  while (start > 0 && (hint - start < WINDOW_BACK_SEGMENTS || (cumulativeM[hint] ?? 0) - (cumulativeM[start] ?? 0) < WINDOW_BACK_M)) {
    start -= 1;
  }
  // The forward reach is measured from where the user was, not from the segment start (a long
  // segment would otherwise hide the road that comes back after a U-turn at its end).
  const end = segmentAtDistance(cumulativeM, hintOrNull.alongM + WINDOW_FORWARD_M) + 1;
  const windowed = nearestInRange(geo, position, start, end, {
    cumulativeM,
    minAlongM: hintOrNull.alongM - WINDOW_BACK_M,
  });
  if (windowed.distanceM <= WINDOW_ACCEPT_M) return windowed;
  return nearestInRange(geo, position, 0, segmentCount);
}

/** The previous match: where the next search starts (see createProgressTracker). */
export interface ProgressHint {
  segment: number;
  alongM: number;
}

/**
 * Where the user is relative to the route. Pure: positions in, numbers out. `hint` is the
 * previous match; without it the whole line is searched.
 */
export function computeProgress(index: RouteIndex, position: LatLng, hint: ProgressHint | null = null): Progress {
  const { route, totalM } = index;
  const projection = locate(index, position, hint);
  const alongM = alongOf(index.cumulativeM, projection);
  const fractionLeft = totalM > 0 ? Math.max(0, Math.min(1, 1 - alongM / totalM)) : 1;
  const last = route.path[route.path.length - 1];
  // Close to the final point AND at the end of the line: a lot passed on the opposite lane, or a
  // loop that ends next to its start, must not count as arrived.
  const isArrived =
    last !== undefined &&
    haversineM(position, toLatLng(last)) <= ARRIVAL_RADIUS_M &&
    alongM >= totalM - ARRIVAL_ALONG_M;
  return {
    offRouteM: projection.distanceM,
    alongM,
    segment: projection.segment,
    remainingM: isArrived ? 0 : Math.round(route.distanceM * fractionLeft),
    remainingS: isArrived ? 0 : Math.round(route.durationS * fractionLeft),
    nextStep: findNextStep(index, alongM),
    isArrived,
  };
}

export interface ProgressTracker {
  /** Progress for a position; remembers the match so the next call stays on the same stretch. */
  update: (position: LatLng) => Progress;
}

/** One tracker per route: a new route (reroute) starts from a global search again. */
export function createProgressTracker(index: RouteIndex): ProgressTracker {
  let hint: ProgressHint | null = null;
  let lastPosition: LatLng | null = null;
  let lastProgress: Progress | null = null;
  return {
    update(position) {
      if (lastProgress !== null && position === lastPosition) return lastProgress;
      const progress = computeProgress(index, position, hint);
      hint = { segment: progress.segment, alongM: progress.alongM };
      lastPosition = position;
      lastProgress = progress;
      return progress;
    },
  };
}

/** How urgent the next maneuver is (drives the emphasis of the instruction card). */
export function maneuverProximity(distanceM: number): Proximity {
  if (distanceM <= NOW_M) return 'now';
  return distanceM <= SOON_M ? 'soon' : 'far';
}

/** Initial compass bearing from `from` to `to`, degrees in [0, 360). */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLng);
  return (((Math.atan2(y, x) * 180) / Math.PI) % 360 + 360) % 360;
}

const CARDINALS: readonly Cardinal[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

export function cardinalOf(deg: number): Cardinal {
  const sector = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return CARDINALS[sector] ?? 'n';
}

export interface FallbackGuidance {
  distanceM: number;
  bearingDeg: number;
  cardinal: Cardinal;
  remainingS: number;
  isArrived: boolean;
}

/**
 * Guidance for an approximate (straight-line) route: no road is known, so only the direction
 * and the crow-flies distance to the destination are given.
 */
export function fallbackGuidance(position: LatLng, destination: LatLng, route: Route): FallbackGuidance {
  const distanceM = Math.round(haversineM(position, destination));
  const speed = route.distanceM > 0 && route.durationS > 0 ? route.distanceM / route.durationS : FALLBACK_SPEED_MPS;
  const bearing = bearingDeg(position, destination);
  const isArrived = distanceM <= ARRIVAL_RADIUS_M;
  return {
    distanceM,
    bearingDeg: bearing,
    cardinal: cardinalOf(bearing),
    remainingS: isArrived ? 0 : Math.round(distanceM / speed),
    isArrived,
  };
}
