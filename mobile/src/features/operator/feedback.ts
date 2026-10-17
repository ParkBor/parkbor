import * as Haptics from 'expo-haptics';

import type { Tone } from '@/features/operator/gateResult';

/** Optional tactile cue for a result (never the only signal: the card has colour + glyph + text). */
export function signalTone(tone: Tone): void {
  const type =
    tone === 'green'
      ? Haptics.NotificationFeedbackType.Success
      : tone === 'amber'
        ? Haptics.NotificationFeedbackType.Warning
        : Haptics.NotificationFeedbackType.Error;
  Haptics.notificationAsync(type).catch(() => undefined);
}
