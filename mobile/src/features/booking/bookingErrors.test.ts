import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';
import uz from '@/i18n/uz.json';
import { BOOKING_ERROR_CODES, classifyBookingError, mustRefreshQuote } from '@/features/booking/bookingErrors';

function httpError(status: number, code?: string): AxiosError {
  const response = { status, data: code ? { code, detail: 'x' } : {}, headers: {}, statusText: '', config: {} } as unknown as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, response);
}

describe('classifyBookingError: contract codes', () => {
  const cases: [number, string, string][] = [
    [409, 'no_slot_available', 'edit'],
    [409, 'booking_conflict', 'edit'],
    [409, 'invalid_transition', 'none'],
    [409, 'idempotency_in_progress', 'same_key'],
    [409, 'qr_not_available', 'none'],
    [409, 'vehicle_busy', 'edit'],
    [409, 'vehicle_in_use', 'none'],
    [409, 'vehicle_exists', 'edit'],
    [409, 'extend_unavailable', 'none'],
    [422, 'idempotency_conflict', 'new_key'],
    [422, 'period_invalid', 'edit'],
    [422, 'period_too_short', 'edit'],
    [422, 'period_too_long', 'edit'],
    [422, 'start_in_past', 'edit'],
    [422, 'too_far_ahead', 'edit'],
    [422, 'lot_closed', 'edit'],
    [422, 'vehicle_not_found', 'edit'],
    [422, 'vehicle_slot_mismatch', 'edit'],
    [422, 'no_tariff', 'none'],
    [422, 'booking_limit_reached', 'none'],
    [422, 'own_lot_booking', 'none'],
    [422, 'vehicle_limit_reached', 'none'],
    [422, 'payment_provider_unavailable', 'edit'],
    [422, 'price_zero', 'none'],
    [429, 'booking_cooldown', 'none'],
    [400, 'idempotency_key_required', 'new_key'],
    [400, 'idempotency_key_invalid', 'new_key'],
    [503, 'lock_timeout', 'same_key'],
    [503, 'service_unavailable', 'same_key'],
    [503, 'serialization_retry', 'same_key'],
  ];

  it.each(cases)('%i %s -> retry %s with a dedicated i18n key', (status, code, retry) => {
    const failure = classifyBookingError(httpError(status, code));
    expect(failure.retry).toBe(retry);
    expect(failure.key).toBe(`booking.error.${code}`);
    expect(failure.code).toBe(code);
  });

  it('exposes exactly the codes in the table', () => {
    expect(BOOKING_ERROR_CODES.length).toBe(cases.length);
  });

  it('every code has a message in uz, ru and en', () => {
    for (const catalog of [uz, ru, en]) {
      const errors = catalog.booking.error as Record<string, string>;
      for (const code of BOOKING_ERROR_CODES) expect(errors[code], code).toBeTruthy();
    }
  });

  it('every generic failure key exists in every language', () => {
    for (const catalog of [uz, ru, en]) {
      for (const key of ['network', 'throttled', 'server', 'notFound', 'generic', 'contract', 'unavailable', 'badRequest']) {
        expect((catalog.failure as Record<string, string>)[key], key).toBeTruthy();
      }
    }
  });
});

describe('classifyBookingError: fallbacks', () => {
  it('uses generic keys for statuses without a machine code', () => {
    expect(classifyBookingError(httpError(404)).key).toBe('failure.notFound');
    expect(classifyBookingError(httpError(429)).key).toBe('failure.throttled');
    expect(classifyBookingError(httpError(502)).retry).toBe('same_key');
  });
});

describe('mustRefreshQuote', () => {
  it('is true when availability/price changed under the user', () => {
    for (const code of ['no_slot_available', 'booking_conflict', 'lot_closed', 'no_tariff']) {
      expect(mustRefreshQuote(classifyBookingError(httpError(409, code))), code).toBe(true);
    }
  });

  it('is false for unrelated failures', () => {
    expect(mustRefreshQuote(classifyBookingError(httpError(429, 'booking_cooldown')))).toBe(false);
    expect(mustRefreshQuote(classifyBookingError(new AxiosError('x', 'ERR_NETWORK')))).toBe(false);
  });
});
