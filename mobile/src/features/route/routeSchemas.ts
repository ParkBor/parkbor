import { z } from 'zod';

import type { LatLng } from '@/features/map/geo';

/** Keys the backend may send (ARCH 10.2); mobile owns the translations. */
export const INSTRUCTION_KEYS = [
  'depart',
  'arrive',
  'turn_left',
  'turn_right',
  'slight_left',
  'slight_right',
  'sharp_left',
  'sharp_right',
  'straight',
  'uturn',
  'roundabout',
  'merge',
  'merge_left',
  'merge_right',
  'fork',
  'fork_left',
  'fork_right',
  'ramp',
  'ramp_left',
  'ramp_right',
  'continue',
  'other',
] as const;

export type InstructionKey = (typeof INSTRUCTION_KEYS)[number];

/** react-native-maps coordinate shape. */
export interface MapPoint {
  latitude: number;
  longitude: number;
}

export interface RouteStep {
  key: InstructionKey;
  /** Raw street name from the server: sanitize before showing (instructionText). */
  name: string;
  distanceM: number;
  durationS: number;
  location: LatLng;
  /** Roundabout exit number (1..50) when the server knows it. */
  roundaboutExit: number | null;
}

export interface Route {
  distanceM: number;
  durationS: number;
  path: MapPoint[];
  steps: RouteStep[];
  /** 'fallback' covers every non-osrm source. */
  source: 'osrm' | 'fallback';
  /** A straight line / estimate, NOT a real road route: must be shown as such. */
  isApproximate: boolean;
}

/** The server answered 200 but the body breaks the contract. Carries no response data. */
export class InvalidRouteResponseError extends Error {
  constructor() {
    super('Invalid route response');
    this.name = 'InvalidRouteResponseError';
  }
}

export const MAX_GEOMETRY_POINTS = 20_000;
export const MAX_STEPS = 600;
const MAX_DISTANCE_M = 10_000_000;
const MAX_DURATION_S = 100_000_000;
const MAX_NAME_LENGTH = 1000;
const MIN_EXIT = 1;
const MAX_EXIT = 50;

const KNOWN_KEYS: ReadonlySet<string> = new Set(INSTRUCTION_KEYS);

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

const positionSchema = z
  .array(z.number())
  .min(2)
  .max(3)
  .refine(([x, y]) => Math.abs(x ?? 181) <= 180 && Math.abs(y ?? 91) <= 90);

const stepSchema = z.object({
  instruction_key: z.string(),
  name: z.string().max(MAX_NAME_LENGTH),
  distance_m: z.number().min(0).max(MAX_DISTANCE_M),
  duration_s: z.number().min(0).max(MAX_DURATION_S),
  location: z.object({ lat, lng }),
  maneuver: z.object({
    type: z.string(),
    modifier: z.string().nullable().optional(),
    exit: z.number().int().min(MIN_EXIT).max(MAX_EXIT).nullable().optional().catch(null),
  }),
});

const routeSchema = z.object({
  distance_m: z.number().int().min(0).max(MAX_DISTANCE_M),
  duration_s: z.number().int().min(0).max(MAX_DURATION_S),
  geometry: z.object({
    type: z.literal('LineString'),
    coordinates: z.array(positionSchema).min(2).max(MAX_GEOMETRY_POINTS),
  }),
  steps: z.array(stepSchema).max(MAX_STEPS),
  source: z.string(),
  approximate: z.boolean().optional(),
});

/** GeoJSON [lng, lat] -> react-native-maps { latitude, longitude }. */
export function toMapPoints(coordinates: readonly (readonly number[])[]): MapPoint[] {
  return coordinates.map((c) => ({ latitude: c[1] ?? 0, longitude: c[0] ?? 0 }));
}

export function isInstructionKey(raw: string): raw is InstructionKey {
  return KNOWN_KEYS.has(raw);
}

function toKey(raw: string): InstructionKey {
  return isInstructionKey(raw) ? raw : 'other';
}

/**
 * Strict validation of GET /routes. Unknown instruction keys degrade to 'other' and an unknown
 * source to 'fallback' (flagged approximate); everything else that breaks the contract throws
 * InvalidRouteResponseError, which never contains response content (coordinates).
 */
export function parseRouteResponse(data: unknown): Route {
  const parsed = routeSchema.safeParse(data);
  if (!parsed.success) throw new InvalidRouteResponseError();
  const r = parsed.data;
  const source = r.source === 'osrm' ? 'osrm' : 'fallback';
  return {
    distanceM: r.distance_m,
    durationS: r.duration_s,
    path: toMapPoints(r.geometry.coordinates),
    steps: r.steps.map((s) => ({
      key: toKey(s.instruction_key),
      name: s.name,
      distanceM: s.distance_m,
      durationS: s.duration_s,
      location: { lat: s.location.lat, lng: s.location.lng },
      roundaboutExit: s.maneuver.exit ?? null,
    })),
    source,
    isApproximate: source !== 'osrm' || r.approximate === true,
  };
}

/** Turn-by-turn only makes sense for a real road route. */
export function isStepByStep(route: Route): boolean {
  return !route.isApproximate;
}
