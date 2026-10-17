import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { checkoutCard } from '@/features/operator/checkoutFlow';
import { classifyOperatorError, withAutoRetry } from '@/features/operator/gateErrors';
import { cardFromCheckIn, cardFromFailure, lostResultCard, type GateCard } from '@/features/operator/gateResult';
import { operatorApi } from '@/features/operator/operatorApi';
import { operatorStore } from '@/features/operator/operatorSession';
import type { ScanMode } from '@/features/operator/operatorStore';
import { canScanNow, createScanGate, validateScanText } from '@/features/operator/scanPolicy';
import { useCardLifecycle } from '@/features/operator/useCardLifecycle';
import { useCheckoutFlow } from '@/features/operator/useCheckoutFlow';
import { operatorKeys } from '@/features/operator/useOperatorLots';

interface PendingEntry {
  token: string;
  plate: string | null;
}

export interface GateScanInput {
  mode: ScanMode;
  lotId: string | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
  /** Entry: the plate check is off, or the typed plate is complete and valid. */
  isPlateReady: boolean;
  /** Validated plate to send with a check-in, or null. */
  plate: string | null;
  /** Called when a result is dismissed or wiped: the typed plate / pasted QR must not outlive it. */
  onWipe: () => void;
}

export type ScanOutcome = 'started' | 'ignored';

export type ScanNotice = { kind: 'bad_qr' } | { kind: 'plate_missing' } | { kind: 'locked'; seconds: number };

const NOTICE_MS = 3000;

class StaleRequest extends Error {}

/**
 * Scan -> request -> result card, for both modes.
 *
 * Wiping (screen left, app backgrounded, mode switched) is done by REMOUNTING the screen body (a
 * `key` driven by scanPolicy.shouldClearOnChange): this hook holds no effects that reset state.
 * The camera keeps running while a result is shown; frames of the same QR only refresh the
 * duplicate window (gate.touch), so dismissing a card never re-sends a code still held in front of
 * the lens. A missing plate gates the NEXT scan only (scanPolicy.canScanNow): it can never remove a
 * card that is already on screen. Tokens live in memory for one flow; nothing is logged or stored.
 */
export function useGateScan(input: GateScanInput) {
  const { mode, lotId, canCheckIn, canCheckOut, isPlateReady, plate, onWipe } = input;
  const queryClient = useQueryClient();
  const [gate] = useState(createScanGate);
  const checkout = useCheckoutFlow(lotId);
  const { state: exitState, reset: resetExit, send, getState: getExitState } = checkout;
  const [entryCard, setEntryCard] = useState<GateCard | null>(null);
  const [isEntryBusy, setIsEntryBusy] = useState(false);
  const [notice, setNotice] = useState<ScanNotice | null>(null);
  const entryActive = useRef(false);
  const isInFlight = useRef(false);
  const pending = useRef<PendingEntry | null>(null);
  const lockedUntilMs = useRef<number | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const epoch = useRef(0);

  const exitResultCard = checkoutCard(exitState);
  const card = entryCard ?? exitResultCard;

  const showNotice = useCallback((next: ScanNotice): void => {
    setNotice((prev) => (prev?.kind === next.kind && next.kind !== 'locked' ? prev : next));
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  // A result that arrived after the previous scanner screen was left: say so, once.
  useEffect(() => {
    if (operatorStore.getState().takeLostResult()) {
      entryActive.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reading a one-shot external flag on mount
      setEntryCard(lostResultCard());
    }
    return () => {
      epoch.current += 1;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, []);

  const runEntry = useCallback(
    async (request: PendingEntry): Promise<void> => {
      if (lotId === null) return;
      const myEpoch = epoch.current;
      entryActive.current = true;
      isInFlight.current = true;
      pending.current = request;
      setIsEntryBusy(true);
      setEntryCard(null);
      let next: GateCard;
      let failureCode: string | null = null;
      let waitSec: number | null = null;
      try {
        const result = await withAutoRetry(() => {
          if (epoch.current !== myEpoch) throw new StaleRequest();
          return operatorApi.checkIn({ token: request.token, lotId, plate: request.plate });
        });
        next = cardFromCheckIn(result);
      } catch (error: unknown) {
        if (error instanceof StaleRequest) {
          isInFlight.current = false;
          return;
        }
        const failure = classifyOperatorError(error);
        failureCode = failure.code;
        waitSec = failure.retryAfterSec;
        next = cardFromFailure(failure);
      }
      isInFlight.current = false;
      void queryClient.invalidateQueries({ queryKey: operatorKeys.slots(lotId) });
      if (epoch.current !== myEpoch) {
        // The screen was left while the request ran: the server has answered, nobody saw it.
        if (next.tone !== 'red') operatorStore.getState().markLostResult();
        return;
      }
      if (failureCode === 'scan_locked' && waitSec !== null) lockedUntilMs.current = Date.now() + waitSec * 1000;
      // A verdict (green / amber / non-retryable red) does not need the token any more.
      if (next.retry === 'none') pending.current = null;
      setIsEntryBusy(false);
      setEntryCard(next);
      gate.release();
    },
    [lotId, gate, queryClient],
  );

  const onScanned = useCallback(
    (text: string): ScanOutcome => {
      const isBlocked = entryActive.current || getExitState().phase !== 'idle';
      const checked = validateScanText(text);
      if (!checked.ok) {
        // A foreign QR (poster, URL) never reaches the server; one notice per window, and never
        // over a result that is on screen.
        if (!isBlocked && gate.invalidNotice()) showNotice({ kind: 'bad_qr' });
        return 'ignored';
      }
      const verdict = canScanNow({
        hasLot: lotId !== null,
        mode,
        canCheckIn,
        canCheckOut,
        isPlateReady,
        isBlocked,
        lockedUntilMs: lockedUntilMs.current,
        nowMs: Date.now(),
      });
      if (!verdict.ok) {
        if (verdict.reason === 'blocked') gate.touch(checked.token);
        else if (verdict.reason === 'plate_missing') showNotice({ kind: 'plate_missing' });
        else if (verdict.reason === 'locked' && lockedUntilMs.current !== null) {
          showNotice({ kind: 'locked', seconds: Math.max(1, Math.ceil((lockedUntilMs.current - Date.now()) / 1000)) });
        }
        return 'ignored';
      }
      if (gate.offer(checked.token) !== 'accept') return 'ignored';
      setNotice(null);
      if (mode === 'entry') {
        void runEntry({ token: checked.token, plate });
        return 'started';
      }
      send({ type: 'start', target: { kind: 'qr', token: checked.token } });
      gate.release();
      return 'started';
    },
    [lotId, mode, canCheckIn, canCheckOut, isPlateReady, plate, gate, runEntry, send, getExitState, showNotice],
  );

  const dismiss = useCallback((): void => {
    // Dismissing while a request still runs: its answer will be dropped, so remember it right away.
    if (isInFlight.current) operatorStore.getState().markLostResult();
    epoch.current += 1;
    pending.current = null;
    entryActive.current = false;
    setIsEntryBusy(false);
    setEntryCard(null);
    resetExit();
    gate.release();
    onWipe();
  }, [gate, resetExit, onWipe]);

  const retry = useCallback((): void => {
    if (entryCard !== null && pending.current !== null) {
      lockedUntilMs.current = null;
      void runEntry(pending.current);
    } else {
      send({ type: 'retry' });
    }
  }, [entryCard, runEntry, send]);

  useCardLifecycle(card, dismiss);

  const isBlocked = isEntryBusy || exitState.phase !== 'idle' || entryCard !== null;
  return { card, exitState, isBlocked, isEntryBusy, notice, onScanned, dismiss, retry, send };
}
