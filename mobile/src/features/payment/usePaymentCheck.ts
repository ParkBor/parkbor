import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { bookingApi } from '@/features/booking/bookingApi';
import type { Booking } from '@/features/booking/bookingSchemas';
import { bookingKeys } from '@/features/booking/queryKeys';
import { useBookingCacheUpdater } from '@/features/booking/useBookings';
import { createPoller, type Poller } from '@/features/payment/paymentPoller';
import { isFatalPollError, startPolling, type PollState } from '@/features/payment/paymentPolling';

/**
 * After the provider sends the user back: ask the SERVER (GET /bookings/{id}) until it says paid /
 * rejected, or the maximum wait is over. The loop is `createPoller` (tested with fake timers); this
 * hook only wires it to React, the cache and the app state: it pauses in the background and checks
 * once at once on return. Nothing from the WebView or the link is used as the result; ids and
 * responses are never logged. `isEnabled` must be the authenticated flag (no tokenless requests).
 * The booking list is refreshed only when the status moves or the check ends, not on every tick.
 */
export function usePaymentCheck(bookingId: string, isEnabled: boolean) {
  const queryClient = useQueryClient();
  const refreshLists = useBookingCacheUpdater();
  const [state, setState] = useState<PollState>(() => startPolling(Date.now()));
  const [booking, setBooking] = useState<Booking | null>(null);
  const poller = useRef<Poller | null>(null);

  const onData = useEffectEvent((fresh: Booking, info: { changed: boolean }): void => {
    queryClient.setQueryData(bookingKeys.detail(fresh.id), fresh);
    if (info.changed) refreshLists(fresh);
    setBooking(fresh);
  });
  const onState = useEffectEvent((next: PollState): void => setState(next));

  useEffect(() => {
    if (!isEnabled) return undefined;
    const instance = createPoller<Booking>({
      now: () => Date.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      load: (signal) => bookingApi.get(bookingId, signal),
      isFatal: isFatalPollError,
      onState: (next) => onState(next),
      onData: (fresh, info) => onData(fresh, info),
    });
    poller.current = instance;
    instance.start();
    const subscription = AppState.addEventListener('change', (appState) => {
      if (appState === 'active') instance.resume();
      else if (appState === 'background') instance.pause();
    });
    return () => {
      subscription.remove();
      instance.stop();
      poller.current = null;
    };
  }, [bookingId, isEnabled]);

  const recheck = (): void => {
    setState(startPolling(Date.now()));
    poller.current?.start();
  };
  return { state, booking, recheck };
}
