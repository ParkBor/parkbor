import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bookingKeys } from '@/features/booking/queryKeys';
import {
  AVAILABILITY_FLUSH_MS,
  BOOKING_REFETCH_MS,
  AVAILABILITY_REFETCH_MS,
  NEARBY_KEY,
  SLOT_REFETCH_MS,
  createCacheBridge,
  operatorSlotsKey,
} from '@/features/realtime/cacheBridge';

const LOT = '2f9c1b0e-8a54-4c1d-9d3e-0a1b2c3d4e5f';
const BOOKING = 'e4d0c1de-1111-4222-8333-444455556666';
const TS = '2026-10-15T13:05:00.123Z';

function fakeClient() {
  const data = new Map<string, unknown>();
  const invalidated: (readonly unknown[])[] = [];
  const setQueriesData = vi.fn();
  return {
    data,
    invalidated,
    setQueriesData,
    client: {
      setQueriesData,
      setQueryData: (key: readonly unknown[], updater: (old: unknown) => unknown) => {
        const k = JSON.stringify(key);
        data.set(k, updater(data.get(k)));
      },
      invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => void invalidated.push(queryKey),
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('availability', () => {
  it('batches count patches for the nearby cache (twice a second at most)', () => {
    const f = fakeClient();
    const bridge = createCacheBridge(f.client);
    bridge.handle({ type: 'availability', lotId: LOT, freeSlots: 5, totalSlots: 10, ts: TS });
    bridge.handle({ type: 'availability', lotId: LOT, freeSlots: 4, totalSlots: 10, ts: TS });
    expect(f.setQueriesData).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AVAILABILITY_FLUSH_MS);
    expect(f.setQueriesData).toHaveBeenCalledTimes(1);
    const [filters, updater] = f.setQueriesData.mock.calls[0] as [
      { queryKey: unknown[]; predicate: (q: { queryKey: unknown[] }) => boolean },
      (old: unknown) => unknown,
    ];
    expect(filters.queryKey).toEqual([...NEARBY_KEY]);
    expect(filters.predicate({ queryKey: ['parkings', 'nearby', 1, 2, 500, null, 'nearest', false] })).toBe(true);
    expect(filters.predicate({ queryKey: ['parkings', 'nearby', 1, 2, 500, 'EV', 'nearest', false] })).toBe(false);
    const before = { results: [{ id: LOT, freeSlots: 9, totalSlots: 10 }] };
    expect(updater(before)).toEqual({ results: [{ id: LOT, freeSlots: 4, totalSlots: 10 }] });
  });

  it('refetches the per-type availability of an open lot screen, but slowly', () => {
    const f = fakeClient();
    const bridge = createCacheBridge(f.client);
    bridge.handle({ type: 'availability', lotId: LOT, freeSlots: 5, totalSlots: 10, ts: TS });
    vi.advanceTimersByTime(AVAILABILITY_REFETCH_MS - 1);
    expect(f.invalidated).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(f.invalidated).toEqual([['parkings', LOT, 'availability']]);
  });
});

describe('slot_status (operator)', () => {
  it('patches the slot map at once and refetches after the burst', () => {
    const f = fakeClient();
    f.data.set(JSON.stringify(operatorSlotsKey(LOT)), { slots: [{ id: 's1', status: 'FREE' }] });
    const bridge = createCacheBridge(f.client);
    bridge.handle({ type: 'slot_status', lotId: LOT, slotId: 's1', status: 'OCCUPIED' });
    bridge.handle({ type: 'slot_status', lotId: LOT, slotId: 's1', status: 'FREE' });
    expect(f.data.get(JSON.stringify(operatorSlotsKey(LOT)))).toEqual({ slots: [{ id: 's1', status: 'FREE' }] });
    expect(f.invalidated).toEqual([]);
    vi.advanceTimersByTime(SLOT_REFETCH_MS);
    expect(f.invalidated).toEqual([['operator', 'slots', LOT]]);
  });

  it('an unknown status only triggers the refetch (never shown as a made-up state)', () => {
    const f = fakeClient();
    const key = JSON.stringify(operatorSlotsKey(LOT));
    f.data.set(key, { slots: [{ id: 's1', status: 'FREE' }] });
    const bridge = createCacheBridge(f.client);
    bridge.handle({ type: 'slot_status', lotId: LOT, slotId: 's1', status: 'MYSTERY' });
    expect(f.data.get(key)).toEqual({ slots: [{ id: 's1', status: 'FREE' }] });
    vi.advanceTimersByTime(SLOT_REFETCH_MS);
    expect(f.invalidated).toHaveLength(1);
  });

  it('does not invent a slot map that was never loaded', () => {
    const f = fakeClient();
    createCacheBridge(f.client).handle({ type: 'slot_status', lotId: LOT, slotId: 's1', status: 'FREE' });
    expect(f.data.get(JSON.stringify(operatorSlotsKey(LOT)))).toBeUndefined();
  });
});

describe('booking_status', () => {
  it('patches the detail at once, then refreshes detail, lists and QR after the batch interval', () => {
    const f = fakeClient();
    f.data.set(JSON.stringify(bookingKeys.detail(BOOKING)), { id: BOOKING, status: 'PENDING_PAYMENT' });
    createCacheBridge(f.client).handle({ type: 'booking_status', bookingId: BOOKING, status: 'CONFIRMED' });
    expect(f.data.get(JSON.stringify(bookingKeys.detail(BOOKING)))).toEqual({ id: BOOKING, status: 'CONFIRMED' });
    expect(f.invalidated).toEqual([]);
    vi.advanceTimersByTime(BOOKING_REFETCH_MS);
    expect(f.invalidated).toEqual([bookingKeys.detail(BOOKING), bookingKeys.qr(BOOKING), ['bookings', 'list']]);
  });

  it('a flood of events for one booking costs one refetch round and the last status wins', () => {
    const f = fakeClient();
    const bridge = createCacheBridge(f.client);
    for (let i = 0; i < 100; i += 1) bridge.handle({ type: 'booking_status', bookingId: BOOKING, status: i % 2 ? 'ACTIVE' : 'CONFIRMED' });
    bridge.handle({ type: 'booking_status', bookingId: BOOKING, status: 'CANCELLED' });
    vi.advanceTimersByTime(BOOKING_REFETCH_MS);
    expect(f.invalidated).toEqual([bookingKeys.detail(BOOKING), ['bookings', 'list']]);
  });

  it.each(['CANCELLED', 'EXPIRED', 'NO_SHOW', 'COMPLETED'])('no QR refetch for %s', (status) => {
    const f = fakeClient();
    createCacheBridge(f.client).handle({ type: 'booking_status', bookingId: BOOKING, status });
    vi.advanceTimersByTime(BOOKING_REFETCH_MS);
    expect(f.invalidated).not.toContainEqual(bookingKeys.qr(BOOKING));
  });

  it.each(['CONFIRMED', 'ACTIVE'])('QR refetch for %s', (status) => {
    const f = fakeClient();
    createCacheBridge(f.client).handle({ type: 'booking_status', bookingId: BOOKING, status });
    vi.advanceTimersByTime(BOOKING_REFETCH_MS);
    expect(f.invalidated).toContainEqual(bookingKeys.qr(BOOKING));
  });

  it('different bookings are refreshed in the same round, the list once', () => {
    const f = fakeClient();
    const bridge = createCacheBridge(f.client);
    bridge.handle({ type: 'booking_status', bookingId: BOOKING, status: 'ACTIVE' });
    bridge.handle({ type: 'booking_status', bookingId: 'other', status: 'ACTIVE' });
    vi.advanceTimersByTime(BOOKING_REFETCH_MS);
    expect(f.invalidated.filter((k) => k[1] === 'list')).toHaveLength(1);
    expect(f.invalidated).toContainEqual(bookingKeys.detail('other'));
  });

  it('an unknown status is not written, only refetched', () => {
    const f = fakeClient();
    const key = JSON.stringify(bookingKeys.detail(BOOKING));
    f.data.set(key, { id: BOOKING, status: 'ACTIVE' });
    createCacheBridge(f.client).handle({ type: 'booking_status', bookingId: BOOKING, status: 'NEW_STATE' });
    expect(f.data.get(key)).toEqual({ id: BOOKING, status: 'ACTIVE' });
    vi.advanceTimersByTime(BOOKING_REFETCH_MS);
    expect(f.invalidated).toEqual([bookingKeys.detail(BOOKING), ['bookings', 'list']]);
  });

  it('does not create a detail entry for a booking that is not cached', () => {
    const f = fakeClient();
    createCacheBridge(f.client).handle({ type: 'booking_status', bookingId: BOOKING, status: 'CONFIRMED' });
    expect(f.data.get(JSON.stringify(bookingKeys.detail(BOOKING)))).toBeUndefined();
  });
});

describe('resync and the rest', () => {
  it('refetches what may have changed while disconnected', () => {
    const f = fakeClient();
    createCacheBridge(f.client).handle({ type: 'resync' });
    expect(f.invalidated).toContainEqual(['bookings']);
    expect(f.invalidated).toContainEqual(['operator', 'slots']);
    expect(f.invalidated).toContainEqual(['parkings', 'nearby']);
  });

  it('ignores events it has no use for', () => {
    const f = fakeClient();
    const bridge = createCacheBridge(f.client);
    bridge.handle({ type: 'error', code: 'unknown_type' });
    bridge.handle({ type: 'subscribed', groups: [], rejected: [] });
    bridge.handle({ type: 'unsubscribed', groups: [] });
    vi.advanceTimersByTime(60_000);
    expect(f.invalidated).toEqual([]);
    expect(f.setQueriesData).not.toHaveBeenCalled();
  });

  it('dispose() drops pending work', () => {
    const f = fakeClient();
    const bridge = createCacheBridge(f.client);
    bridge.handle({ type: 'availability', lotId: LOT, freeSlots: 1, totalSlots: 2, ts: TS });
    bridge.handle({ type: 'slot_status', lotId: LOT, slotId: 's', status: 'FREE' });
    bridge.dispose();
    vi.advanceTimersByTime(60_000);
    expect(f.setQueriesData).not.toHaveBeenCalled();
    expect(f.invalidated).toEqual([]);
  });
});
