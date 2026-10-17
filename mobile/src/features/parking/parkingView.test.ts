import { describe, expect, it } from 'vitest';

import type { Availability } from '@/features/booking/quoteSchemas';
import type { NearbyResponse, Parking } from '@/features/map/schemas';
import { findCachedParking, isValidParkingId, slotTypeRows } from '@/features/parking/parkingView';

const ID = 'b2f0c1de-1111-4222-8333-444455556666';
const OTHER = 'c2f0c1de-1111-4222-8333-444455556666';

function parking(id: string, name = 'Lot'): Parking {
  return {
    id,
    name,
    address: 'addr',
    location: { lat: 41.3, lng: 69.2 },
    distanceM: 100,
    durationS: 60,
    freeSlots: 3,
    totalSlots: 10,
    pricePerHour: '5000.00',
    rating: null,
    isOpen: true,
    score: null,
  };
}

const response = (...lots: Parking[]): NearbyResponse => ({ results: lots, radiusUsedM: 1000, count: lots.length, skippedCount: 0 });

function availability(slotType: Availability['slotType'], total: number, available: number, isOpen = true): Availability {
  return { slotType, startMs: 0, endMs: 1, total, available, isOpen };
}

describe('isValidParkingId', () => {
  it('accepts UUIDs only', () => {
    expect(isValidParkingId(ID)).toBe(true);
    expect(isValidParkingId(['x'])).toBe(false);
    expect(isValidParkingId(undefined)).toBe(false);
    expect(isValidParkingId('1')).toBe(false);
  });
});

describe('findCachedParking', () => {
  it('finds the lot in any cached nearby response', () => {
    const found = findCachedParking([undefined, response(parking(OTHER)), response(parking(ID, 'Chorsu'))], ID);
    expect(found?.name).toBe('Chorsu');
  });

  it('returns null when it is not cached (deep link)', () => {
    expect(findCachedParking([response(parking(OTHER))], ID)).toBeNull();
    expect(findCachedParking([], ID)).toBeNull();
  });
});

describe('slotTypeRows', () => {
  it('keeps the canonical order and hides types the lot does not have', () => {
    const rows = slotTypeRows([
      { slotType: 'EV', data: availability('EV', 4, 1) },
      { slotType: 'STANDARD', data: availability('STANDARD', 20, 7) },
      { slotType: 'LARGE', data: availability('LARGE', 0, 0) },
      { slotType: 'DISABLED', data: null },
    ]);
    expect(rows.map((r) => r.slotType)).toEqual(['STANDARD', 'EV']);
    expect(rows[0]).toEqual({ slotType: 'STANDARD', available: 7, total: 20, isFull: false, isOpen: true });
  });

  it('marks a type with no free slots as full', () => {
    const rows = slotTypeRows([{ slotType: 'STANDARD', data: availability('STANDARD', 5, 0) }]);
    expect(rows[0]?.isFull).toBe(true);
  });

  it('a closed lot reports nothing available', () => {
    const rows = slotTypeRows([{ slotType: 'STANDARD', data: availability('STANDARD', 5, 0, false) }]);
    expect(rows[0]).toMatchObject({ isOpen: false, isFull: true });
  });
});
