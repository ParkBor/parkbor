import { describe, expect, it } from 'vitest';

import {
  applyAvailability,
  applyBookingStatus,
  applySlotStatus,
  isNearbyQueryPatchable,
  knownBookingStatus,
  knownSlotStatus,
} from '@/features/realtime/cacheUpdates';

const LOT_A = '2f9c1b0e-8a54-4c1d-9d3e-0a1b2c3d4e5f';
const LOT_B = '3f9c1b0e-8a54-4c1d-9d3e-0a1b2c3d4e5f';

const parking = (id: string, free: number, total = 10) => ({ id, name: 'n', freeSlots: free, totalSlots: total });
const nearby = (...results: ReturnType<typeof parking>[]) => ({ results, radiusUsedM: 500, count: results.length, skippedCount: 0 });

describe('applyAvailability', () => {
  it('updates only the lots named in the batch, immutably', () => {
    const before = nearby(parking(LOT_A, 3), parking(LOT_B, 4));
    const after = applyAvailability(before, new Map([[LOT_A, { freeSlots: 1, totalSlots: 12 }]]));
    expect(after?.results[0]).toMatchObject({ id: LOT_A, freeSlots: 1, totalSlots: 12 });
    expect(after?.results[1]).toBe(before.results[1]);
    expect(before.results[0]?.freeSlots).toBe(3);
    expect(after).not.toBe(before);
  });

  it('returns the same object when nothing changed (no re-render)', () => {
    const before = nearby(parking(LOT_A, 3));
    expect(applyAvailability(before, new Map([[LOT_A, { freeSlots: 3, totalSlots: 10 }]]))).toBe(before);
    expect(applyAvailability(before, new Map([['other', { freeSlots: 0, totalSlots: 0 }]]))).toBe(before);
    expect(applyAvailability(before, new Map())).toBe(before);
  });

  it('leaves missing data alone', () => {
    expect(applyAvailability(undefined, new Map([[LOT_A, { freeSlots: 1, totalSlots: 1 }]]))).toBeUndefined();
  });
});

describe('isNearbyQueryPatchable', () => {
  const key = (slotType: unknown) => ['parkings', 'nearby', 41.3, 69.2, 500, slotType, 'nearest', false];

  it('patches unfiltered searches only: with a spot-type filter the counts are per type', () => {
    expect(isNearbyQueryPatchable(key(null))).toBe(true);
    expect(isNearbyQueryPatchable(key('EV'))).toBe(false);
  });

  it('refuses keys of another shape', () => {
    expect(isNearbyQueryPatchable(['parkings', LOT_A, 'availability'])).toBe(false);
    expect(isNearbyQueryPatchable([])).toBe(false);
  });
});

describe('applySlotStatus', () => {
  const map = {
    lot: { id: LOT_A },
    truncated: false,
    slots: [
      { id: 's1', status: 'FREE' },
      { id: 's2', status: 'OCCUPIED' },
    ],
  };

  it('changes one slot immutably', () => {
    const after = applySlotStatus(map, 's1', 'OUT_OF_SERVICE');
    expect(after?.slots[0]?.status).toBe('OUT_OF_SERVICE');
    expect(after?.slots[1]).toBe(map.slots[1]);
    expect(map.slots[0]?.status).toBe('FREE');
  });

  it('returns the same object for an unknown slot or an unchanged status', () => {
    expect(applySlotStatus(map, 'zzz', 'FREE')).toBe(map);
    expect(applySlotStatus(map, 's1', 'FREE')).toBe(map);
    expect(applySlotStatus(undefined, 's1', 'FREE')).toBeUndefined();
  });
});

describe('applyBookingStatus', () => {
  it('changes the status immutably', () => {
    const before = { id: 'b', status: 'PENDING_PAYMENT', total: 1 };
    const after = applyBookingStatus(before, 'CONFIRMED');
    expect(after).toEqual({ id: 'b', status: 'CONFIRMED', total: 1 });
    expect(before.status).toBe('PENDING_PAYMENT');
  });

  it('returns the same object when unchanged or absent', () => {
    const before = { id: 'b', status: 'ACTIVE' };
    expect(applyBookingStatus(before, 'ACTIVE')).toBe(before);
    expect(applyBookingStatus(undefined, 'ACTIVE')).toBeUndefined();
  });
});

describe('status vocabularies', () => {
  it('knows the booking statuses of the backend and nothing else', () => {
    expect(knownBookingStatus('CONFIRMED')).toBe('CONFIRMED');
    expect(knownBookingStatus('EXPIRED')).toBe('EXPIRED');
    expect(knownBookingStatus('WHATEVER')).toBeNull();
    expect(knownBookingStatus('')).toBeNull();
  });

  it('knows the slot statuses', () => {
    for (const status of ['FREE', 'RESERVED', 'OCCUPIED', 'OUT_OF_SERVICE']) expect(knownSlotStatus(status)).toBe(status);
    expect(knownSlotStatus('BROKEN')).toBeNull();
  });
});
