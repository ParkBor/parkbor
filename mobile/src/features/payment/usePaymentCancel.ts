import { useCallback, useState } from 'react';

import type { PaymentFlow } from '@/features/payment/usePaymentFlow';

/**
 * Cancelling from the pay screen: re-read the booking first (a payment may have gone through
 * meanwhile) and only then ask. While the user is cancelling, the screen does not react to the
 * status change itself (no detour through "payment not accepted"): the only navigation is the
 * one after the dialog.
 */
export function usePaymentCancel(flow: PaymentFlow) {
  const { query, startCancelling, stopCancelling, leaveAfterChange, goToBooking } = flow;
  const { refetch } = query;
  const [isOpen, setIsOpen] = useState(false);

  const request = useCallback(async (): Promise<void> => {
    startCancelling();
    const result = await refetch();
    const fresh = result.isError ? undefined : result.data;
    if (fresh !== undefined && fresh.status !== 'PENDING_PAYMENT') {
      leaveAfterChange();
      return;
    }
    setIsOpen(true);
  }, [refetch, startCancelling, leaveAfterChange]);

  const close = useCallback((): void => {
    stopCancelling();
    setIsOpen(false);
  }, [stopCancelling]);

  const done = useCallback((): void => {
    setIsOpen(false);
    goToBooking();
  }, [goToBooking]);

  return { isOpen, request, close, done };
}
