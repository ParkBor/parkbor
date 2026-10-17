import type { QueryObserverResult } from '@tanstack/react-query';
import { useEffect, useEffectEvent } from 'react';

import type { Booking } from '@/features/booking/bookingSchemas';
import { serverClock } from '@/features/booking/serverClock';
import { holdLapseAction } from '@/features/payment/payFlow';

const MAX_TIMER_MS = 2 ** 31 - 1;
const RETRY_AFTER_ERROR_MS = 5000;
const MIN_REARM_MS = 1000;

interface HoldWatchOptions {
  isEnabled: boolean;
  holdExpiresAtMs: number | null;
  refetch: () => Promise<QueryObserverResult<Booking, unknown>>;
  /** The SERVER confirmed the hold is over (or the booking changed): close the payment page. */
  onLapsed: () => void;
}

/**
 * The device clock reaching `hold_expires_at` does not end a payment: the server extends the hold
 * (up to 5 minutes) when the provider transaction starts. At that moment the booking is re-read and
 * only a SERVER answer that agrees (`holdLapseAction`) closes the page. A failed read changes nothing
 * and is retried. One timer, no per-second rendering.
 */
export function usePaymentHoldWatch({ isEnabled, holdExpiresAtMs, refetch, onLapsed }: HoldWatchOptions): void {
  const reread = useEffectEvent(refetch);
  const lapsed = useEffectEvent(onLapsed);

  useEffect(() => {
    if (!isEnabled || holdExpiresAtMs === null) return undefined;
    let isCancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const arm = (delayMs: number): void => {
      timer = setTimeout(() => void check(), Math.min(Math.max(0, delayMs), MAX_TIMER_MS));
    };
    const check = async (): Promise<void> => {
      const result = await reread();
      if (isCancelled) return;
      const fresh = result.isError ? undefined : result.data;
      if (fresh === undefined) {
        arm(RETRY_AFTER_ERROR_MS);
      } else if (holdLapseAction(fresh, serverClock.now()) === 'close') {
        lapsed();
      } else {
        const next = fresh.holdExpiresAtMs === null ? RETRY_AFTER_ERROR_MS : fresh.holdExpiresAtMs - serverClock.now();
        arm(Math.max(MIN_REARM_MS, next));
      }
    };

    arm(holdExpiresAtMs - serverClock.now());
    return () => {
      isCancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isEnabled, holdExpiresAtMs]);
}
