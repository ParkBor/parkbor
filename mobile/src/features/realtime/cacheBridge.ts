import { bookingKeys } from '@/features/booking/queryKeys';
import { canShowQr } from '@/features/booking/statusView';
import { applyAvailability, applyBookingStatus, applySlotStatus, isNearbyQueryPatchable, knownBookingStatus, knownSlotStatus, type LotCounts } from '@/features/realtime/cacheUpdates';
import { createBatcher } from '@/features/realtime/batcher';
import type { RealtimeEvent } from '@/features/realtime/realtimeClient';

/** Free counts reach the map at most twice a second. */
export const AVAILABILITY_FLUSH_MS = 500;
/** Per-type availability on the lot screen costs 4 requests, so refetch it far less often. */
export const AVAILABILITY_REFETCH_MS = 3000;
/** Operator slot map: patch at once, refetch (plates, bookings) once the burst is over. */
export const SLOT_REFETCH_MS = 2000;
/** booking_status: the patch is instant, the refetches are coalesced per booking. */
export const BOOKING_REFETCH_MS = 1000;

// Same shapes as features/operator/useOperatorLots (operatorKeys) and map/search (nearbyQueryKey);
// kept literal here so this module stays free of React Native imports. cacheBridge.test pins them.
export const operatorSlotsKey = (lotId: string) => ['operator', 'slots', lotId] as const;
export const NEARBY_KEY = ['parkings', 'nearby'] as const;
const lotAvailabilityKey = (lotId: string) => ['parkings', lotId, 'availability'] as const;

/** The part of QueryClient the bridge uses (kept narrow so tests need no React). */
export interface CacheClient {
  setQueriesData: (
    filters: { queryKey: readonly unknown[]; predicate: (query: { queryKey: readonly unknown[] }) => boolean },
    updater: (old: unknown) => unknown,
  ) => unknown;
  setQueryData: (queryKey: readonly unknown[], updater: (old: unknown) => unknown) => unknown;
  invalidateQueries: (filters: { queryKey: readonly unknown[]; refetchType: 'active' }) => unknown;
}

export interface CacheBridge {
  handle: (event: RealtimeEvent) => void;
  dispose: () => void;
}

export function createCacheBridge(client: CacheClient): CacheBridge {
  const invalidate = (queryKey: readonly unknown[]): void => void client.invalidateQueries({ queryKey, refetchType: 'active' });

  const counts = createBatcher<string, LotCounts>((batch) => {
    client.setQueriesData(
      { queryKey: NEARBY_KEY, predicate: (query) => isNearbyQueryPatchable(query.queryKey) },
      (old) => applyAvailability(old as Parameters<typeof applyAvailability>[0], batch),
    );
  }, AVAILABILITY_FLUSH_MS);

  const lotRefetch = createBatcher<string, true>((batch) => {
    for (const lotId of batch.keys()) invalidate(lotAvailabilityKey(lotId));
  }, AVAILABILITY_REFETCH_MS);

  const slotRefetch = createBatcher<string, true>((batch) => {
    for (const lotId of batch.keys()) invalidate(operatorSlotsKey(lotId));
  }, SLOT_REFETCH_MS);

  // The newest status per booking wins; one refetch round per second however many events arrive.
  const bookingRefetch = createBatcher<string, string>((batch) => {
    for (const [bookingId, rawStatus] of batch) {
      invalidate(bookingKeys.detail(bookingId));
      // A QR exists only for some statuses; asking for it otherwise just earns a 409.
      const status = knownBookingStatus(rawStatus);
      if (status && canShowQr(status)) invalidate(bookingKeys.qr(bookingId));
    }
    invalidate([...bookingKeys.all, 'list']);
  }, BOOKING_REFETCH_MS);

  function onBookingStatus(bookingId: string, rawStatus: string): void {
    const status = knownBookingStatus(rawStatus);
    if (status) {
      client.setQueryData(bookingKeys.detail(bookingId), (old) => applyBookingStatus(old as { status: string } | undefined, status));
    }
    // The patch is instant; the refetch brings refund, payment and QR details the event lacks.
    bookingRefetch.add(bookingId, rawStatus);
  }

  function onSlotStatus(lotId: string, slotId: string, rawStatus: string): void {
    const status = knownSlotStatus(rawStatus);
    if (status) {
      client.setQueryData(operatorSlotsKey(lotId), (old) => applySlotStatus(old as Parameters<typeof applySlotStatus>[0], slotId, status));
    }
    slotRefetch.add(lotId, true);
  }

  return {
    handle(event) {
      switch (event.type) {
        case 'availability':
          counts.add(event.lotId, { freeSlots: event.freeSlots, totalSlots: event.totalSlots });
          lotRefetch.add(event.lotId, true);
          return;
        case 'slot_status':
          onSlotStatus(event.lotId, event.slotId, event.status);
          return;
        case 'booking_status':
          onBookingStatus(event.bookingId, event.status);
          return;
        case 'resync':
          invalidate(bookingKeys.all);
          invalidate(['operator', 'slots']);
          invalidate(NEARBY_KEY);
          invalidate(['parkings']);
          return;
        default:
          return;
      }
    },
    dispose() {
      counts.cancel();
      lotRefetch.cancel();
      slotRefetch.cancel();
      bookingRefetch.cancel();
    },
  };
}
