import type { Availability } from '@/features/booking/quoteSchemas';
import { SLOT_TYPES, type NearbyResponse, type Parking, type SlotType } from '@/features/map/schemas';
import { isUuid } from '@/lib/contract';

export function isValidParkingId(value: unknown): value is string {
  return isUuid(value);
}

/** The lot as the map last saw it (in-memory nearby cache). null for a deep link to a lot never listed. */
export function findCachedParking(responses: readonly (NearbyResponse | undefined)[], id: string): Parking | null {
  for (const response of responses) {
    const hit = response?.results.find((lot) => lot.id === id);
    if (hit) return hit;
  }
  return null;
}

export interface SlotTypeRow {
  slotType: SlotType;
  available: number;
  total: number;
  isFull: boolean;
  isOpen: boolean;
}

export interface SlotTypeAnswer {
  slotType: SlotType;
  /** null while loading or failed. */
  data: Availability | null;
}

/** Free slots per type, in canonical order; types the lot does not have (total 0) are hidden. */
export function slotTypeRows(answers: readonly SlotTypeAnswer[]): SlotTypeRow[] {
  return SLOT_TYPES.flatMap((slotType) => {
    const data = answers.find((answer) => answer.slotType === slotType)?.data;
    if (!data || data.total === 0) return [];
    return [{ slotType, available: data.available, total: data.total, isFull: data.available === 0, isOpen: data.isOpen }];
  });
}
