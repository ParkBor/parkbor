import { isUuid } from '@/lib/contract';

// A push payload is data from the network: only `habi://booking/<uuid>` is followed. Other
// schemes, hosts, paths, queries and fragments are ignored rather than "fixed up".

const MAX_URL_LENGTH = 200;
const BOOKING_URL = /^habi:\/\/booking\/([0-9a-f-]{36})\/?$/i;

export function bookingIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null;
  const id = BOOKING_URL.exec(url)?.[1];
  return id !== undefined && isUuid(id) ? id : null;
}

export function bookingIdFromNotificationData(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  return bookingIdFromUrl((data as { url?: unknown }).url);
}

/** A tap that could not be opened within this long is stale (the user moved on). */
export const PENDING_TAP_TTL_MS = 5 * 60_000;

export interface PendingTap {
  id: string;
  atMs: number;
}

export type PendingDecision = { type: 'open'; id: string } | { type: 'wait' } | { type: 'drop' };

/**
 * A tapped notification may arrive before the app is signed in (cold start) or while onboarding
 * is open. The booking id is held until it can be opened - and only once the auth guard has
 * settled (current route inside the authenticated area), or the guard's own redirect would
 * replace the screen we just pushed. A tap that waits longer than PENDING_TAP_TTL_MS is dropped.
 */
export function decidePendingTap(
  pending: PendingTap | null,
  session: { isAuthenticated: boolean; isOnboardingDone: boolean; isGuardSettled: boolean },
  nowMs: number,
): PendingDecision {
  if (pending === null) return { type: 'drop' };
  if (nowMs - pending.atMs > PENDING_TAP_TTL_MS || nowMs < pending.atMs) return { type: 'drop' };
  if (!session.isAuthenticated || !session.isOnboardingDone || !session.isGuardSettled) return { type: 'wait' };
  return { type: 'open', id: pending.id };
}

export interface ResponseDeduper {
  isNew: (identifier: string | undefined) => boolean;
}

/** The same tap can be delivered by the last-response lookup and by the listener. */
export function createResponseDeduper(max: number = 20): ResponseDeduper {
  const seen: string[] = [];
  return {
    isNew(identifier) {
      if (identifier === undefined) return true;
      if (seen.includes(identifier)) return false;
      seen.push(identifier);
      if (seen.length > max) seen.shift();
      return true;
    },
  };
}
