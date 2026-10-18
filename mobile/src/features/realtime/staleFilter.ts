const DEFAULT_MAX_LOTS = 500;

export interface StaleFilter {
  /** False when `ts` is older than the newest event already applied for this lot. */
  accept: (lotId: string, ts: string) => boolean;
  forget: (lotId: string) => void;
  clear: () => void;
  size: () => number;
}

/**
 * `availability` can be reordered around a snapshot. `ts` is UTC ISO-8601 with milliseconds and a
 * fixed width, so comparing the strings orders the instants. Equal timestamps are accepted
 * (idempotent). Bounded: geo cells can carry any number of lots.
 */
export function createStaleFilter(maxLots: number = DEFAULT_MAX_LOTS): StaleFilter {
  const newest = new Map<string, string>();
  return {
    accept(lotId, ts) {
      const known = newest.get(lotId);
      if (known !== undefined && ts < known) return false;
      newest.delete(lotId); // re-insert keeps the Map ordered by recency
      newest.set(lotId, ts);
      if (newest.size > maxLots) {
        const oldest = newest.keys().next().value;
        if (oldest !== undefined) newest.delete(oldest);
      }
      return true;
    },
    forget: (lotId) => void newest.delete(lotId),
    clear: () => newest.clear(),
    size: () => newest.size,
  };
}
