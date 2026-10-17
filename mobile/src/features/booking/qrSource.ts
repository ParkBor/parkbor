export const QR_ACTIVATION_LEAD_MS = 2 * 3_600_000;

/** The entry QR becomes scannable 2 hours before the start (operator side, ARCHITECTURE 10.8). */
export function isQrActive(startMs: number, nowMs: number): boolean {
  return nowMs >= startMs - QR_ACTIVATION_LEAD_MS;
}

export interface QrToken {
  token: string;
  expiresAtMs: number;
  /** Served from the keystore copy. */
  isFromDevice: boolean;
}

interface Entry {
  token: string;
  expiresAtMs: number;
}

export interface QrSourceDeps {
  /** onlineManager state; unknown counts as online. */
  isOnline: boolean;
  nowMs: number;
  loadCached: () => Promise<Entry | null>;
  fetchFresh: () => Promise<Entry>;
  isNetworkError: (error: unknown) => boolean;
}

/**
 * Where the QR comes from:
 * - the device knows it is offline and a copy that has not expired is stored: show it at once
 *   (no waiting for a request timeout);
 * - otherwise ask the server; if that fails with a NETWORK error, fall back to the unexpired copy;
 * - a server verdict (404/409/429...) is never hidden behind an old copy.
 * Expiry is judged by the clock passed in, so the caller decides which clock to trust.
 */
export async function resolveQr(deps: QrSourceDeps): Promise<QrToken> {
  const usable = async (): Promise<Entry | null> => {
    const cached = await deps.loadCached();
    return cached !== null && cached.expiresAtMs > deps.nowMs ? cached : null;
  };
  if (!deps.isOnline) {
    const cached = await usable();
    if (cached) return { ...cached, isFromDevice: true };
  }
  try {
    return { ...(await deps.fetchFresh()), isFromDevice: false };
  } catch (error: unknown) {
    if (!deps.isNetworkError(error)) throw error;
    const cached = await usable();
    if (cached) return { ...cached, isFromDevice: true };
    throw error;
  }
}
