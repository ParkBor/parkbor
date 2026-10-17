// Polling (realtime arrives with Step 10). The server allows 120 GET/min per user; 15 s is 4/min.

export const SLOT_POLL_MS = 15_000;
export const MAX_POLL_MS = 60_000;
/** The lot list changes rarely (assignments, status). */
export const LOTS_STALE_MS = 30_000;
/** /me is re-read at most this often to notice a role change. */
export const ROLE_REFRESH_MS = 60_000;

export interface PollInput {
  isFocused: boolean;
  isAppActive: boolean;
  isOnline: boolean;
  /** Consecutive failed refetches. */
  failures: number;
}

/** Interval for the slot map, or false (no polling) while it would be wasted or unreachable. */
export function slotPollInterval({ isFocused, isAppActive, isOnline, failures }: PollInput): number | false {
  if (!isFocused || !isAppActive || !isOnline) return false;
  const exponent = Math.min(Math.max(0, failures), 10);
  return Math.min(SLOT_POLL_MS * 2 ** exponent, MAX_POLL_MS);
}

export function roleRefreshDue(input: { lastAtMs: number | null; nowMs: number }): boolean {
  if (input.lastAtMs === null) return true;
  const elapsed = input.nowMs - input.lastAtMs;
  return elapsed < 0 || elapsed >= ROLE_REFRESH_MS;
}
