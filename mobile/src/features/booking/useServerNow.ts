import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { serverClock } from '@/features/booking/serverClock';

/**
 * Server-corrected "now" in epoch ms, re-read every `tickMs` while the app is in the foreground
 * (and immediately when it returns from the background, when timers were frozen).
 */
export function useServerNow(tickMs = 1000, isEnabled = true): number {
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    if (!isEnabled) return undefined;
    let id: ReturnType<typeof setInterval> | null = setInterval(() => setNow(serverClock.now()), tickMs);
    const subscription = AppState.addEventListener('change', (state) => {
      if (id !== null) clearInterval(id);
      id = null;
      if (state === 'active') {
        setNow(serverClock.now());
        id = setInterval(() => setNow(serverClock.now()), tickMs);
      }
    });
    return () => {
      if (id !== null) clearInterval(id);
      subscription.remove();
    };
  }, [tickMs, isEnabled]);
  return now;
}
