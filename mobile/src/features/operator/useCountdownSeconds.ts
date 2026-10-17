import { useEffect, useState } from 'react';

interface Ticks {
  /** Identifies the wait these ticks belong to (a new wait, even with the same length, starts at zero). */
  id: string;
  elapsed: number;
}

/**
 * Whole seconds left of a `Retry-After` wait (counts down once a second); 0 when there is none.
 * `restartKey` changes for every new failure, so a second wait of the SAME length starts again.
 */
export function useCountdownSeconds(seconds: number | null, restartKey = 0): number {
  const id = `${seconds ?? 0}:${restartKey}`;
  const [ticks, setTicks] = useState<Ticks>({ id: '', elapsed: 0 });
  useEffect(() => {
    if (!seconds) return undefined;
    const timer = setInterval(
      () => setTicks((prev) => (prev.id === id ? { id, elapsed: prev.elapsed + 1 } : { id, elapsed: 1 })),
      1000,
    );
    return () => clearInterval(timer);
  }, [seconds, id]);
  if (!seconds) return 0;
  const elapsed = ticks.id === id ? ticks.elapsed : 0;
  return Math.max(0, seconds - elapsed);
}
