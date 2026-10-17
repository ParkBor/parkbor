import { describeFailure, type CodeRules, type Failure } from '@/lib/failure';

// Backend error codes of the booking API (ARCHITECTURE 9.5) and what the client may do about them.
// Policy:
// - Transient (503 lock_timeout / serialization_retry / service_unavailable, 409 idempotency_in_progress, 429, network,
//   5xx): repeat with the SAME Idempotency-Key - the server deduplicates, so a lost response
//   cannot become a second booking.
// - The server releases the key after a failed attempt, so after a business error the user fixes
//   the input; the draft fingerprint then decides whether the key is reused or renewed.
// - 422 idempotency_conflict / 400 idempotency_key_*: the key itself is unusable -> new key.
const RULES: CodeRules = {
  // 409
  no_slot_available: { retry: 'edit' },
  booking_conflict: { retry: 'edit' },
  invalid_transition: { retry: 'none' },
  idempotency_in_progress: { retry: 'same_key' },
  qr_not_available: { retry: 'none' },
  vehicle_busy: { retry: 'edit' },
  vehicle_in_use: { retry: 'none' },
  vehicle_exists: { retry: 'edit' },
  extend_unavailable: { retry: 'none' },
  // 422
  idempotency_conflict: { retry: 'new_key' },
  period_invalid: { retry: 'edit' },
  period_too_short: { retry: 'edit' },
  period_too_long: { retry: 'edit' },
  start_in_past: { retry: 'edit' },
  too_far_ahead: { retry: 'edit' },
  lot_closed: { retry: 'edit' },
  vehicle_not_found: { retry: 'edit' },
  vehicle_slot_mismatch: { retry: 'edit' },
  no_tariff: { retry: 'none' },
  booking_limit_reached: { retry: 'none' },
  own_lot_booking: { retry: 'none' },
  vehicle_limit_reached: { retry: 'none' },
  // The chosen / default provider is not configured: pick another one (the picker learns from this code).
  payment_provider_unavailable: { retry: 'edit' },
  price_zero: { retry: 'none' },
  // 429 (the throttle itself has no code and falls back to failure.throttled)
  // Retrying at once is useless (10-minute window): the message tells the user to wait.
  booking_cooldown: { retry: 'none' },
  // 400
  idempotency_key_required: { retry: 'new_key' },
  idempotency_key_invalid: { retry: 'new_key' },
  // 503
  lock_timeout: { retry: 'same_key' },
  service_unavailable: { retry: 'same_key' },
  // Server already retried once internally; repeating with the same key is safe (no duplicate).
  serialization_retry: { retry: 'same_key' },
};

export const BOOKING_ERROR_CODES: readonly string[] = Object.keys(RULES);

/** Failure -> `booking.error.<code>` (or a generic `failure.*`) plus the retry/idempotency advice. */
export function classifyBookingError(error: unknown): Failure {
  return describeFailure(error, RULES, 'booking.error');
}

const QUOTE_STALE_CODES: ReadonlySet<string> = new Set(['no_slot_available', 'booking_conflict', 'lot_closed', 'no_tariff']);

/** Availability / price changed under the user: refetch the quote before offering a retry. */
export function mustRefreshQuote(failure: Failure): boolean {
  return failure.code !== null && QUOTE_STALE_CODES.has(failure.code);
}
