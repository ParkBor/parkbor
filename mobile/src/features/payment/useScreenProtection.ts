import {
  allowScreenCaptureAsync,
  disableAppSwitcherProtectionAsync,
  enableAppSwitcherProtectionAsync,
  preventScreenCaptureAsync,
} from 'expo-screen-capture';
import { useEffect } from 'react';

const SCREEN_CAPTURE_KEY = 'habi-payment';
const ignore = (): void => undefined;

/**
 * While the payment page can be on screen: no screenshots / recordings (Android FLAG_SECURE, iOS
 * best effort) and a blurred app-switcher preview. Tied to focus. Platform support differs, so a
 * refusal is swallowed: the screen must still work.
 */
export function useScreenProtection(isFocused: boolean): void {
  useEffect(() => {
    if (!isFocused) return undefined;
    void preventScreenCaptureAsync(SCREEN_CAPTURE_KEY).catch(ignore);
    void enableAppSwitcherProtectionAsync().catch(ignore);
    return () => {
      void allowScreenCaptureAsync(SCREEN_CAPTURE_KEY).catch(ignore);
      void disableAppSwitcherProtectionAsync().catch(ignore);
    };
  }, [isFocused]);
}
