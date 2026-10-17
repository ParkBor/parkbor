import { onlineManager } from '@tanstack/react-query';
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { classifyBookingError } from '@/features/booking/bookingErrors';
import { CancelDialog } from '@/features/booking/CancelDialog';
import { resolveBookingParam } from '@/features/booking/deepLink';
import { PayFooter, PayHeader, PayUnavailable, SecureNote } from '@/features/payment/PayBodies';
import { PaymentWebView } from '@/features/payment/PaymentWebView';
import { useExitConfirm } from '@/features/payment/useExitConfirm';
import { usePaymentCancel } from '@/features/payment/usePaymentCancel';
import { usePaymentFlow } from '@/features/payment/usePaymentFlow';
import { useScreenProtection } from '@/features/payment/useScreenProtection';
import { loadState } from '@/lib/loadState';
import { usePalette } from '@/theme/theme';

const isDeviceOffline = (): boolean => !onlineManager.isOnline();

/**
 * booking/pay: the provider checkout in a locked-down WebView (ARCHITECTURE 13.5). The result of the
 * WebView is never trusted: when the provider returns, or the server shows a different status, the
 * user moves to payment/result, which re-reads the booking from the server.
 */
export function PaymentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const target = resolveBookingParam(params.id);

  useEffect(() => {
    if (!target.ok) router.replace('/(tabs)/bookings');
  }, [target.ok, router]);

  return target.ok ? <Payment id={target.id} /> : null;
}

function Payment({ id }: { id: string }) {
  const p = usePalette();
  const isFocused = useIsFocused();
  const { flow, webViewRef } = usePaymentFlow(id);
  const cancel = usePaymentCancel(flow);
  const { query, availability, goToBooking, goToResult } = flow;
  const booking = query.data;
  useScreenProtection(isFocused);
  const confirmExit = useExitConfirm({
    isFocused,
    canCancelBooking: booking !== undefined,
    onLeave: goToBooking,
    onCancelBooking: () => void cancel.request(),
  });

  const state = loadState({ hasData: booking !== undefined, isPending: query.isPending, isError: query.isError, fetchStatus: query.fetchStatus });
  const messageKey = state === 'offline' ? 'common.offline' : state === 'error' ? classifyBookingError(query.error).key : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.background }}>
      <PayHeader booking={booking} />
      {availability?.kind === 'ready' ? (
        <>
          <SecureNote />
          <PaymentWebView
            ref={webViewRef}
            url={availability.url}
            onResult={goToResult}
            onExit={confirmExit}
            onCheckStatus={goToResult}
            isDeviceOffline={isDeviceOffline}
          />
          <PayFooter onCheckStatus={goToResult} onCancelPayment={confirmExit} />
        </>
      ) : (
        <PayUnavailable
          availability={availability}
          failure={{ state, messageKey, onRetry: () => void query.refetch() }}
          canCancel={booking !== undefined}
          onViewBooking={goToBooking}
          onCancel={() => void cancel.request()}
        />
      )}
      {booking ? <CancelDialog booking={booking} isOpen={cancel.isOpen} onClose={cancel.close} onCancelled={cancel.done} /> : null}
    </SafeAreaView>
  );
}
