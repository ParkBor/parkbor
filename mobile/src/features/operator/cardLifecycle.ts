import type { Tone } from '@/features/operator/gateResult';
import { cardTtlMs } from '@/features/operator/scanPolicy';

export interface CardTimerInput {
  tone: Tone;
  /** Cash or a retry is pending: the card stays until the operator acts. */
  needsAction: boolean;
  /** A screen reader is on: no time limit (WCAG 2.2.1), the operator dismisses it. */
  isScreenReader: boolean;
  onDismiss: () => void;
}

/** Starts the auto-dismiss timer of a result card; returns the function that cancels it. */
export function startCardTimer(input: CardTimerInput): () => void {
  const ttl = input.isScreenReader ? null : cardTtlMs(input.tone, input.needsAction);
  if (ttl === null) return () => undefined;
  const timer = setTimeout(input.onDismiss, ttl);
  return () => clearTimeout(timer);
}
