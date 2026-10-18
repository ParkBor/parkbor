/**
 * While the socket is live polling is only a safety net: the backend publishes fail-open and
 * there is no replay, so an event can be lost without the connection noticing. The net must
 * therefore stay tight.
 */
export const LIVE_SAFETY_POLL_MS = 30_000;
/** A booking waiting for payment is the one users watch: its net is tighter. */
export const PENDING_PAYMENT_SAFETY_POLL_MS = 15_000;

/**
 * Polling interval to use given the realtime state. When the socket is down (or not yet up) the
 * normal polling interval applies unchanged, so the screens degrade to the pre-WebSocket behaviour.
 */
export function relaxWhenLive(intervalMs: number | false, isRealtimeLive: boolean): number | false {
  if (intervalMs === false) return false;
  return isRealtimeLive ? Math.max(intervalMs, LIVE_SAFETY_POLL_MS) : intervalMs;
}

export interface BookingPollInput {
  /** The booking is in a status that can still change (statusView.isLiveStatus). */
  isChangeable: boolean;
  status: string;
  pollMs: number;
  /** The caller chose the interval on purpose (payment screen): realtime never relaxes it. */
  isExplicit: boolean;
  isRealtimeLive: boolean;
}

export function bookingPollInterval(input: BookingPollInput): number | false {
  if (!input.isChangeable) return false;
  if (!input.isRealtimeLive || input.isExplicit) return input.pollMs;
  const ceiling = input.status === 'PENDING_PAYMENT' ? PENDING_PAYMENT_SAFETY_POLL_MS : LIVE_SAFETY_POLL_MS;
  return Math.max(input.pollMs, ceiling);
}
