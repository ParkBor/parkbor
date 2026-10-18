export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;
export const BACKOFF_JITTER = 0.3;
/** After 4410 (12 h max age) nothing is wrong: reconnect almost at once. */
export const IMMEDIATE_RECONNECT_MS = 250;

/**
 * Reconnect delay: 1 s doubling to a 60 s ceiling, spread by +-30 % so a server restart does not
 * bring every phone back in the same second. `random` is injected (0..1) to keep this pure.
 */
export function backoffDelay(attempt: number, random: number): number {
  const n = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n, 16));
  const r = Math.min(1, Math.max(0, random));
  return Math.round(base * (1 + (r * 2 - 1) * BACKOFF_JITTER));
}
