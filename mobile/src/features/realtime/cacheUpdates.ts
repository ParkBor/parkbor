import { BOOKING_STATUSES, type KnownBookingStatus } from '@/features/booking/bookingSchemas';

// Pure cache patches for realtime events. Each returns the SAME object when nothing changes, so
// TanStack Query does not notify subscribers (no re-render) for a no-op event.

export type SlotStatusName = 'FREE' | 'RESERVED' | 'OCCUPIED' | 'OUT_OF_SERVICE';
const SLOT_STATUSES: readonly string[] = ['FREE', 'RESERVED', 'OCCUPIED', 'OUT_OF_SERVICE'];
const BOOKING_STATUS_NAMES: readonly string[] = BOOKING_STATUSES;

export function knownBookingStatus(status: string): KnownBookingStatus | null {
  return BOOKING_STATUS_NAMES.includes(status) ? (status as KnownBookingStatus) : null;
}

export function knownSlotStatus(status: string): SlotStatusName | null {
  return SLOT_STATUSES.includes(status) ? (status as SlotStatusName) : null;
}

export interface LotCounts {
  freeSlots: number;
  totalSlots: number;
}

interface NearbyLike {
  results: { id: string; freeSlots: number; totalSlots: number }[];
}

/** Free-spot counts of lots in a cached nearby search. */
export function applyAvailability<T extends NearbyLike>(data: T | undefined, updates: ReadonlyMap<string, LotCounts>): T | undefined {
  if (!data || updates.size === 0) return data;
  let isChanged = false;
  const results = data.results.map((parking) => {
    const update = updates.get(parking.id);
    if (!update || (update.freeSlots === parking.freeSlots && update.totalSlots === parking.totalSlots)) return parking;
    isChanged = true;
    return { ...parking, freeSlots: update.freeSlots, totalSlots: update.totalSlots };
  });
  return isChanged ? { ...data, results } : data;
}

/**
 * Nearby query key: ['parkings','nearby',lat,lng,radius,slotType,sort,onlyOpen]. With a spot-type
 * filter the cached counts are for THAT type, while the event carries the lot's total free count,
 * so only unfiltered searches can be patched.
 */
export function isNearbyQueryPatchable(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === 'parkings' && queryKey[1] === 'nearby' && queryKey.length >= 6 && queryKey[5] === null;
}

interface SlotMapLike {
  slots: { id: string; status: string }[];
}

export function applySlotStatus<T extends SlotMapLike>(map: T | undefined, slotId: string, status: SlotStatusName): T | undefined {
  if (!map) return map;
  const index = map.slots.findIndex((slot) => slot.id === slotId);
  const slot = map.slots[index];
  if (!slot || slot.status === status) return map;
  const slots = map.slots.slice();
  slots[index] = { ...slot, status };
  return { ...map, slots };
}

export function applyBookingStatus<T extends { status: string }>(booking: T | undefined, status: KnownBookingStatus): T | undefined {
  if (!booking || booking.status === status) return booking;
  return { ...booking, status };
}
