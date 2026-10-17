import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import type { Booking } from '@/features/booking/bookingSchemas';
import { CancelDialog } from '@/features/booking/CancelDialog';
import { canCancelStatus } from '@/features/booking/statusView';
import { useNowAt } from '@/features/booking/useNowAt';
import { payAvailability } from '@/features/payment/payAvailability';
import type { NearbyResponse } from '@/features/map/schemas';
import { findCachedParking } from '@/features/parking/parkingView';
import { formatCoordParam } from '@/features/route/lotParams';

function useOpenNavigation(booking: Booking): () => void {
  const router = useRouter();
  const queryClient = useQueryClient();
  return () => {
    const lot = findCachedParking(
      queryClient.getQueriesData<NearbyResponse>({ queryKey: ['parkings', 'nearby'] }).map(([, data]) => data),
      booking.parkingLot.id,
    );
    router.push({
      pathname: '/navigate/[parkingId]',
      params: {
        parkingId: booking.parkingLot.id,
        name: booking.parkingLot.name,
        ...(lot ? { lat: formatCoordParam(lot.location.lat), lng: formatCoordParam(lot.location.lng) } : {}),
      },
    });
  };
}

/** Pay / directions / extend (not yet available) / cancel, depending on the status. */
export function BookingActions({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  const openNavigation = useOpenNavigation(booking);
  const now = useNowAt(booking.holdExpiresAtMs, booking.status === 'PENDING_PAYMENT');
  const pay = payAvailability(booking, now);
  const { status } = booking;
  const isLive = status === 'CONFIRMED' || status === 'ACTIVE';

  return (
    <>
      {status === 'PENDING_PAYMENT' ? (
        <>
          <Button
            label={t('booking.detail.pay')}
            disabled={pay.kind !== 'ready'}
            onPress={() => router.push({ pathname: '/booking/pay', params: { id: booking.id } })}
          />
          {pay.kind !== 'ready' && pay.kind !== 'not_pending' ? <ErrorText message={t(`payment.unavailable.${pay.kind}`)} /> : null}
        </>
      ) : null}
      {status === 'PENDING_PAYMENT' || isLive ? <Button label={t('booking.detail.navigate')} onPress={openNavigation} /> : null}
      {/* Extending needs payments (Step 8): the server answers 409 extend_unavailable. */}
      {isLive ? <Button variant="secondary" disabled label={t('booking.detail.extendSoon')} onPress={() => undefined} /> : null}
      {canCancelStatus(status) ? (
        <Button variant="secondary" label={t('booking.detail.cancel')} onPress={() => setIsCancelOpen(true)} />
      ) : null}
      <CancelDialog
        booking={booking}
        isOpen={isCancelOpen}
        onClose={() => setIsCancelOpen(false)}
        onCancelled={() => setIsCancelOpen(false)}
      />
    </>
  );
}
