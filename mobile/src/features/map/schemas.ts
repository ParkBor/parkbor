import { z } from 'zod';

export type SlotType = 'STANDARD' | 'EV' | 'DISABLED' | 'LARGE';
export type SortMode = 'recommended' | 'nearest' | 'cheapest';

export const SLOT_TYPES: readonly SlotType[] = ['STANDARD', 'EV', 'DISABLED', 'LARGE'];
export const SORT_MODES: readonly SortMode[] = ['recommended', 'nearest', 'cheapest'];

const count = z.number().int().min(0);
/** Backend DecimalField(max_digits=12, decimal_places=2). Also keeps String(n) free of exponents. */
const MAX_PRICE = 9_999_999_999.99;
const DECIMAL_PATTERN =/^\d+(\.\d+)?$/;

const parkingSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]).transform(String),
  name: z.string(),
  address: z.string(),
  location: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  distance_m: z.number().min(0),
  duration_s: count.nullable(),
  free_slots: count,
  total_slots: count,
  // DRF DecimalField serialises to a string (COERCE_DECIMAL_TO_STRING defaults to true and the
  // backend does not override it); a plain number is tolerated. Always normalised to a string:
  // money is never kept as a float.
  price_per_hour: z.union([z.string().regex(DECIMAL_PATTERN), z.number().min(0).max(MAX_PRICE)]).transform(String).nullable(),
  rating: z.number().nullable(),
  is_open: z.boolean(),
  score: z.number().nullable(),
});

const envelopeSchema = z.object({
  results: z.array(z.unknown()),
  radius_used_m: z.number().min(0),
  count,
});

export interface Parking {
  id: string;
  name: string;
  address: string;
  location: { lat: number; lng: number };
  distanceM: number;
  durationS: number | null;
  freeSlots: number;
  totalSlots: number;
  /** Decimal string such as "12000.00". */
  pricePerHour: string | null;
  rating: number | null;
  isOpen: boolean;
  score: number | null;
}

export interface NearbyResponse {
  results: Parking[];
  radiusUsedM: number;
  count: number;
  /** Items of the response that were dropped for not matching the contract. */
  skippedCount: number;
}

/** The server answered 200 but the body does not match the contract. Carries no response data. */
export class InvalidResponseError extends Error {
  constructor() {
    super('Invalid nearby parkings response');
    this.name = 'InvalidResponseError';
  }
}

function toParking(r: z.infer<typeof parkingSchema>): Parking {
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    location: { lat: r.location.lat, lng: r.location.lng },
    distanceM: r.distance_m,
    durationS: r.duration_s,
    freeSlots: r.free_slots,
    totalSlots: r.total_slots,
    pricePerHour: r.price_per_hour,
    rating: r.rating,
    isOpen: r.is_open,
    score: r.score,
  };
}

/**
 * The envelope is strict. Items are validated one by one: a malformed lot is dropped (and counted)
 * instead of blanking the whole map. If items arrived but none is valid, the contract is broken
 * and the response is rejected. Errors never carry response content (coordinates).
 */
export function parseNearbyResponse(data: unknown): NearbyResponse {
  const envelope = envelopeSchema.safeParse(data);
  if (!envelope.success) throw new InvalidResponseError();
  const { results, radius_used_m: radiusUsedM, count: total } = envelope.data;

  const parkings: Parking[] = [];
  for (const raw of results) {
    const item = parkingSchema.safeParse(raw);
    if (item.success) parkings.push(toParking(item.data));
  }
  if (results.length > 0 && parkings.length === 0) throw new InvalidResponseError();
  return { results: parkings, radiusUsedM, count: total, skippedCount: results.length - parkings.length };
}
