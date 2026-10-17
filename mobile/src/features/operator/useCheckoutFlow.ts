import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { checkoutReducer, IDLE, type CheckoutEvent, type CheckoutState } from '@/features/operator/checkoutFlow';
import { classifyOperatorError, withAutoRetry } from '@/features/operator/gateErrors';
import { operatorApi } from '@/features/operator/operatorApi';
import { operatorStore } from '@/features/operator/operatorSession';
import type { LostKind } from '@/features/operator/operatorStore';
import { operatorKeys } from '@/features/operator/useOperatorLots';

export interface CheckoutController {
  state: CheckoutState;
  /** Latest state, readable synchronously (event handlers / camera callbacks). */
  getState: () => CheckoutState;
  /** Applies an event; false when the transition is not allowed (e.g. a second press). */
  send: (event: CheckoutEvent) => boolean;
  /** Back to idle; answers of requests started before this call are dropped. */
  reset: () => void;
}

/** The screen was left before the (automatic) second attempt: that request is simply not sent. */
class StaleRequest extends Error {}

/**
 * Runs the two-step exit (checkoutFlow) against the API. Exactly one request is sent per
 * `requesting` state, a transient 503 is repeated once automatically (but never after the screen
 * was left), and the amounts only ever come from the server answers held in the state.
 *
 * If the screen is left while a request runs, the server may still have released the car: a
 * success (or an unreadable 2xx) is remembered in the operator store and shown as "result not
 * shown" when a scanner is open again. The slot map is refreshed after every settled request.
 */
export function useCheckoutFlow(lotId: string | null, lostKind: LostKind = 'gate'): CheckoutController {
  const queryClient = useQueryClient();
  const [state, setState] = useState<CheckoutState>(IDLE);
  const stateRef = useRef<CheckoutState>(IDLE);
  const startedFor = useRef<CheckoutState | null>(null);
  const epoch = useRef(0);

  const send = useCallback((event: CheckoutEvent): boolean => {
    const next = checkoutReducer(stateRef.current, event);
    if (next === stateRef.current) return false;
    stateRef.current = next;
    setState(next);
    return true;
  }, []);

  const getState = useCallback((): CheckoutState => stateRef.current, []);

  useEffect(() => {
    if (state.phase !== 'requesting' || startedFor.current === state || lotId === null) return;
    startedFor.current = state;
    const myEpoch = epoch.current;
    const { target, step } = state;
    const refreshMap = (): void => {
      void queryClient.invalidateQueries({ queryKey: operatorKeys.slots(lotId) });
    };
    withAutoRetry(() => {
      if (epoch.current !== myEpoch) throw new StaleRequest();
      return operatorApi.checkOut({ target, lotId, collect: step === 'collect' });
    })
      .then((res) => {
        refreshMap();
        if (epoch.current === myEpoch) send({ type: 'response', res });
        else operatorStore.getState().markLostResult(lostKind);
      })
      .catch((error: unknown) => {
        if (error instanceof StaleRequest) return;
        const failure = classifyOperatorError(error);
        refreshMap();
        if (epoch.current === myEpoch) send({ type: 'failed', failure });
        else if (failure.reasonKey === 'operator.reason.contract') operatorStore.getState().markLostResult(lostKind);
      });
  }, [state, lotId, send, queryClient, lostKind]);

  // Leaving the screen: answers of requests still running are not applied to a dead component.
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    [],
  );

  const reset = useCallback((): void => {
    // Resetting while a request runs drops its answer: remember that something was not shown.
    if (stateRef.current.phase === 'requesting') operatorStore.getState().markLostResult(lostKind);
    epoch.current += 1;
    startedFor.current = null;
    stateRef.current = IDLE;
    setState(IDLE);
  }, [lostKind]);

  return { state, getState, send, reset };
}
