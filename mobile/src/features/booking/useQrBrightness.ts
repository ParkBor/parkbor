import * as Brightness from 'expo-brightness';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { createBrightnessBoost, type BrightnessApi } from '@/features/booking/brightness';

const platformBrightness: BrightnessApi = {
  get: () => Brightness.getBrightnessAsync(),
  set: (value) => Brightness.setBrightnessAsync(value),
  // Android: drop the window override (follow the system again) instead of pinning a number.
  ...(Platform.OS === 'android' ? { reset: () => Brightness.restoreSystemBrightnessAsync() } : {}),
};

// One boost for the whole app: brightness is a single global value (iOS), so two instances could
// each remember the other's boosted level as "original".
const boost = createBrightnessBoost(platformBrightness);

/**
 * Full brightness while `isActive` (the QR is on screen and the screen is focused). The previous
 * level is restored on cleanup and whenever the app goes to the background (and re-applied on
 * return), so the phone is never left bright.
 */
export function useQrBrightness(isActive: boolean): void {
  useEffect(() => {
    if (!isActive) return undefined;
    void boost.activate();
    const subscription = AppState.addEventListener('change', (state) => {
      void (state === 'active' ? boost.activate() : boost.deactivate());
    });
    return () => {
      subscription.remove();
      void boost.deactivate();
    };
  }, [isActive]);
}
