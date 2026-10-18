// The server allows 10 messages/s with a one-second burst and charges one token per ELEMENT of a
// subscribe/unsubscribe. The client keeps a little under that so clock jitter and the pongs it
// sends on top never tip the connection into a 4429 close.
export const BUCKET_CAPACITY = 8;
export const BUCKET_REFILL_PER_S = 8;

export interface TokenBucket {
  /** Pays `cost` (capped at the capacity) if available. */
  take: (cost: number) => boolean;
  /** Milliseconds until `cost` can be paid (0 = now). */
  waitMs: (cost: number) => number;
}

export function createTokenBucket(now: () => number): TokenBucket {
  let tokens = BUCKET_CAPACITY;
  let last = now();

  const refill = (): void => {
    const t = now();
    const elapsedS = Math.max(0, t - last) / 1000;
    last = t;
    tokens = Math.min(BUCKET_CAPACITY, tokens + elapsedS * BUCKET_REFILL_PER_S);
  };
  const priced = (cost: number): number => Math.min(Math.max(cost, 1), BUCKET_CAPACITY);

  return {
    take(cost) {
      refill();
      const price = priced(cost);
      if (tokens < price) return false;
      tokens -= price;
      return true;
    },
    waitMs(cost) {
      refill();
      const missing = priced(cost) - tokens;
      return missing <= 0 ? 0 : Math.ceil((missing / BUCKET_REFILL_PER_S) * 1000);
    },
  };
}
