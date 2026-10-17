import { ContractError } from '@/lib/contract';
import { parseApiError } from '@/lib/errors';

// Error policy of the operator API (ARCHITECTURE 9.2). The reason is ALWAYS an i18n key
// (`operator.reason.<code>`): backend `detail` text is never shown, logged or returned.
//
// Retry policy:
// - auto_once: 503 lock_timeout / serialization_retry / service_unavailable - nothing changed on the
//   server, the same request is repeated once automatically, then a manual button;
// - wait: 429 (scan_locked, invite_locked, throttle) - show the remaining time from Retry-After;
// - manual: network / 5xx - the operator repeats by hand;
// - none: a verdict (wrong lot, expired QR, ...): repeating the same scan cannot help.

export type RetryPolicy = 'auto_once' | 'manual' | 'wait' | 'none';

export interface GateFailure {
  reasonKey: string;
  code: string | null;
  status: number | null;
  retry: RetryPolicy;
  /** Seconds from `Retry-After` (1..3600), when the server sent a usable one. */
  retryAfterSec: number | null;
}

export const AUTO_RETRY_DELAY_MS = 600;
const MAX_RETRY_AFTER_SEC = 3600;

const VERDICT_CODES = [
  // 400 / 403 / 404
  'validation_error', 'parking_lot_required', 'qr_invalid', 'qr_expired', 'qr_not_yet_valid', 'qr_wrong_purpose',
  'self_service_forbidden', 'exit_qr_required', 'booking_not_found', 'force_not_allowed', 'invite_invalid',
  // 409
  'wrong_lot', 'qr_outdated', 'already_used', 'plate_mismatch', 'booking_not_paid', 'booking_expired',
  'booking_cancelled', 'booking_no_show', 'booking_completed', 'booking_over', 'too_early', 'slot_occupied',
  'slot_out_of_service', 'not_checked_in', 'booking_not_active', 'slot_reserved_soon', 'plate_busy', 'slot_in_use',
  'slot_has_bookings',
  // 409: the charge is capped / unpriced and waits for an owner's or administrator's decision
  'needs_review',
  // 409 on the driver's QR endpoint; may surface when a stale code is scanned
  'qr_not_available',
  // 422
  'no_tariff', 'vehicle_slot_mismatch', 'plate_invalid',
  // 422: the lot requires the plate at check-in and none was sent
  'plate_required',
] as const;
const TRANSIENT_CODES = ['lock_timeout', 'serialization_retry', 'service_unavailable'] as const;
// Timing refusals: the message carries the remaining seconds from Retry-After.
const LOCK_CODES = ['scan_locked', 'invite_locked', 'walk_in_rate_limited'] as const;

const RETRY_BY_CODE: ReadonlyMap<string, RetryPolicy> = new Map<string, RetryPolicy>([
  ...VERDICT_CODES.map((code): [string, RetryPolicy] => [code, 'none']),
  ...TRANSIENT_CODES.map((code): [string, RetryPolicy] => [code, 'auto_once']),
  ...LOCK_CODES.map((code): [string, RetryPolicy] => [code, 'wait']),
]);

export const OPERATOR_ERROR_CODES: readonly string[] = [...RETRY_BY_CODE.keys()];

/** `Retry-After` in whole seconds (HTTP-date form is not used by the API): 1..3600, else null. */
export function parseRetryAfter(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d{1,9}$/.test(text)) return null;
  const seconds = Number(text);
  return seconds >= 1 ? Math.min(seconds, MAX_RETRY_AFTER_SEC) : null;
}

function readRetryAfter(error: unknown): number | null {
  const headers = (error as { response?: { headers?: unknown } } | null)?.response?.headers;
  if (typeof headers !== 'object' || headers === null) return null;
  const record = headers as { get?: (name: string) => unknown } & Record<string, unknown>;
  const fromGet = typeof record.get === 'function' ? record.get('retry-after') : undefined;
  return parseRetryAfter(fromGet ?? record['retry-after'] ?? record['Retry-After']);
}

function failure(
  reason: string,
  retry: RetryPolicy,
  info: { code?: string; status?: number },
  retryAfterSec: number | null = null,
): GateFailure {
  return { reasonKey: `operator.reason.${reason}`, code: info.code ?? null, status: info.status ?? null, retry, retryAfterSec };
}

/** Failed operator request -> reason key + retry policy. Never exposes backend text. */
export function classifyOperatorError(error: unknown): GateFailure {
  if (error instanceof ContractError) return failure('contract', 'none', {});
  const info = parseApiError(error);
  if (info.kind === 'network') return failure('network', 'manual', {});
  if (info.kind === 'unknown') return failure('generic', 'none', {});

  const code = info.code !== undefined && RETRY_BY_CODE.has(info.code) ? info.code : undefined;
  if (code !== undefined) {
    const retry = RETRY_BY_CODE.get(code) ?? 'none';
    return failure(code, retry, info, retry === 'wait' ? readRetryAfter(error) : null);
  }
  const { status } = info;
  if (status === 429) return failure('throttled', 'wait', info, readRetryAfter(error));
  // A 422 with a code this version does not know is still a refusal of the request, not a crash.
  if (status === 422) return failure('validation', 'none', { status }, null);
  if (status === 401) return failure('unauthorized', 'none', info);
  if (status === 403) return failure('forbidden', 'none', info);
  if (status === 404) return failure('not_found', 'none', info);
  if (status === 503) return failure('unavailable', 'manual', info);
  if (status !== undefined && status >= 500) return failure('server', 'manual', info);
  return failure('generic', 'none', info);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a request; after a transient 503 (nothing changed on the server) repeats it exactly once.
 * A second failure goes to the caller, who shows a manual retry button.
 */
export async function withAutoRetry<T>(task: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  try {
    return await task();
  } catch (error: unknown) {
    if (classifyOperatorError(error).retry !== 'auto_once') throw error;
    await wait(AUTO_RETRY_DELAY_MS);
    return task();
  }
}
