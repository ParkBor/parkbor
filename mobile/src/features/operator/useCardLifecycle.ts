import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { startCardTimer } from '@/features/operator/cardLifecycle';
import { signalTone } from '@/features/operator/feedback';
import { cardNeedsAction, type GateCard, type Tone } from '@/features/operator/gateResult';

/** True while a screen reader is on (cards then wait for the operator instead of vanishing). */
export function useScreenReader(): boolean {
  const [isOn, setIsOn] = useState(false);
  useEffect(() => {
    let isCurrent = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((value) => {
        if (isCurrent) setIsOn(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setIsOn);
    return () => {
      isCurrent = false;
      subscription.remove();
    };
  }, []);
  return isOn;
}

interface AutoDismissInput {
  isShown: boolean;
  tone: Tone;
  needsAction: boolean;
  onDismiss: () => void;
}

/** Auto-dismiss (5 s green / 8 s otherwise) for anything shown as a result; see cardLifecycle. */
export function useAutoDismiss({ isShown, tone, needsAction, onDismiss }: AutoDismissInput): void {
  const isScreenReader = useScreenReader();
  useEffect(() => {
    if (!isShown) return undefined;
    return startCardTimer({ tone, needsAction, isScreenReader, onDismiss });
  }, [isShown, tone, needsAction, isScreenReader, onDismiss]);
}

/** Result card: optional haptic cue once per card + auto-dismiss unless an action is pending. */
export function useCardLifecycle(card: GateCard | null, onDismiss: () => void): void {
  useEffect(() => {
    if (card !== null) signalTone(card.tone);
  }, [card]);
  useAutoDismiss({
    isShown: card !== null,
    tone: card?.tone ?? 'green',
    needsAction: card !== null && cardNeedsAction(card),
    onDismiss,
  });
}
