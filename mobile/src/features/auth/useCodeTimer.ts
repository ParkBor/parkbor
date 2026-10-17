import { useEffect, useState } from 'react';

import { remainingSeconds } from '@/features/auth/code';

/** Seconds left until `expiresAt` (epoch ms), ticking once per second; 0 without a session. */
export function useCodeTimer(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt === null) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return expiresAt === null ? 0 : remainingSeconds(expiresAt, now);
}
