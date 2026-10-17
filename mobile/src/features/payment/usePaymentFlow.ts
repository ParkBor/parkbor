import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { serverClock } from '@/features/booking/serverClock';
import { useBooking } from '@/features/booking/useBookings';
import { rememberPaymentBooking } from '@/features/payment/lastPayment';
import { payAvailability, type PayAvailability } from '@/features/payment/payAvailability';
import { payNavigation } from '@/features/payment/payFlow';
import type { PaymentWebViewHandle } from '@/features/payment/PaymentWebView';
import { usePaymentHoldWatch } from '@/features/payment/usePaymentHoldWatch';

/** While the provider page is open, follow the server hold (it is extended when a transaction starts). */
const HOLD_POLL_MS = 5000;

export interface PaymentFlow {
  query: ReturnType<typeof useBooking>;
  availability: PayAvailability | null;
  goToBooking: () => void;
  goToResult: () => void;
  /** The user opened the cancel dialog: the status change that follows is their own doing. */
  startCancelling: () => void;
  stopCancelling: () => void;
  /** The booking is no longer payable: the result screen if the page was shown, else the detail. */
  leaveAfterChange: () => void;
}

/**
 * Navigation brain of the pay screen. The hold is judged ONCE, when the screen opens; afterwards only
 * a fresh SERVER answer may end it (`usePaymentHoldWatch`): a device clock that runs ahead must not
 * close a payment in progress. Leaving always wipes the page first (the native view cannot be cleaned
 * after it is unmounted).
 */
export function usePaymentFlow(id: string): { flow: PaymentFlow; webViewRef: RefObject<PaymentWebViewHandle | null> } {
  const router = useRouter();
  const query = useBooking(id, HOLD_POLL_MS);
  const [openedAtMs] = useState(() => serverClock.now());
  const hasOpened = useRef(false);
  const isUserCancelling = useRef(false);
  const webViewRef = useRef<PaymentWebViewHandle>(null);

  const booking = query.data;
  const availability = booking ? payAvailability(booking, openedAtMs) : null;
  const kind = availability?.kind;
  const isReady = kind === 'ready';

  const goToBooking = useCallback((): void => {
    webViewRef.current?.clearSession();
    router.dismissTo({ pathname: '/booking/[id]', params: { id } });
  }, [router, id]);
  const goToResult = useCallback((): void => {
    webViewRef.current?.clearSession();
    router.replace({ pathname: '/payment/result', params: { id } });
  }, [router, id]);

  useEffect(() => {
    if (!isReady) return;
    hasOpened.current = true;
    rememberPaymentBooking(id);
  }, [isReady, id]);

  useEffect(() => {
    if (kind === undefined) return;
    const target = payNavigation(kind, { hasOpened: hasOpened.current, isUserCancelling: isUserCancelling.current });
    if (target === 'result') goToResult();
    else if (target === 'detail') goToBooking();
  }, [kind, goToResult, goToBooking]);

  usePaymentHoldWatch({
    isEnabled: isReady,
    holdExpiresAtMs: booking?.holdExpiresAtMs ?? null,
    refetch: query.refetch,
    onLapsed: () => {
      if (!isUserCancelling.current) goToResult();
    },
  });

  const startCancelling = useCallback((): void => {
    isUserCancelling.current = true;
  }, []);
  const stopCancelling = useCallback((): void => {
    isUserCancelling.current = false;
  }, []);
  const leaveAfterChange = useCallback((): void => {
    isUserCancelling.current = false;
    if (hasOpened.current) goToResult();
    else goToBooking();
  }, [goToResult, goToBooking]);

  const flow: PaymentFlow = { query, availability, goToBooking, goToResult, startCancelling, stopCancelling, leaveAfterChange };
  return { flow, webViewRef };
}
