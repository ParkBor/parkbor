import { useEffect, useState } from 'react';

import { serverClock } from '@/features/booking/serverClock';

const MAX_TIMER_MS = 2 ** 31 - 1;
const SLACK_MS = 50;

/**
 * Server-corrected "now", refreshed ONCE when `targetMs` is reached (no per-second timer): for
 * "is this hold still alive" decisions on lists and buttons that do not show a countdown.
 */
export function useNowAt(targetMs: number | null, isEnabled = true): number {
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    if (!isEnabled || targetMs === null) return undefined;
    const delay = targetMs - serverClock.now();
    if (delay <= 0) return undefined;
    const id = setTimeout(() => setNow(serverClock.now()), Math.min(delay + SLACK_MS, MAX_TIMER_MS));
    return () => clearTimeout(id);
  }, [targetMs, isEnabled]);
  return now;
}
