import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';
import uz from '@/i18n/uz.json';
import {
  AUTO_RETRY_DELAY_MS,
  classifyOperatorError,
  OPERATOR_ERROR_CODES,
  parseRetryAfter,
  withAutoRetry,
} from '@/features/operator/gateErrors';
import { ContractError } from '@/lib/contract';

function httpError(status: number, code?: string, headers: Record<string, string> = {}): AxiosError {
  const response = { status, data: code ? { code, detail: 'secret detail 01A123BC' } : {}, headers, statusText: '', config: {} } as unknown as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, response);
}

type Tree = { [key: string]: string | Tree };
function reasonOf(catalog: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Tree | undefined)?.[part], catalog);
}

// Hand-written from ARCHITECTURE 9.2 (+ the Step 9a final review): every machine code the operator
// API can answer. The table in gateErrors.ts must cover exactly these, nothing is derived from it.
const VERDICT_DOC_CODES = [
  'validation_error', 'parking_lot_required', 'qr_invalid', 'qr_expired', 'qr_not_yet_valid', 'qr_wrong_purpose',
  'self_service_forbidden', 'exit_qr_required', 'booking_not_found', 'wrong_lot', 'qr_outdated', 'already_used',
  'plate_mismatch', 'booking_not_paid', 'booking_expired', 'booking_cancelled', 'booking_no_show', 'booking_completed',
  'booking_over', 'too_early', 'slot_occupied', 'slot_out_of_service', 'not_checked_in', 'booking_not_active',
  'needs_review', 'plate_required', 'qr_not_available', 'slot_reserved_soon', 'plate_busy', 'no_tariff',
  'vehicle_slot_mismatch', 'plate_invalid', 'slot_in_use', 'slot_has_bookings', 'force_not_allowed', 'invite_invalid',
];
const TRANSIENT_DOC_CODES = ['lock_timeout', 'serialization_retry', 'service_unavailable'];
const WAIT_DOC_CODES = ['scan_locked', 'invite_locked', 'walk_in_rate_limited'];
const GENERIC_REASONS = ['network', 'throttled', 'forbidden', 'unauthorized', 'not_found', 'server', 'unavailable', 'generic', 'contract', 'validation'];

describe('classifyOperatorError: contract codes (ARCHITECTURE 9.2)', () => {
  it.each(VERDICT_DOC_CODES)('%s: dedicated key, no automatic retry', (code) => {
    const f = classifyOperatorError(httpError(409, code));
    expect(f.reasonKey).toBe(`operator.reason.${code}`);
    expect(f.code).toBe(code);
    expect(f.retry).toBe('none');
  });

  it.each(TRANSIENT_DOC_CODES)('503 %s: one automatic retry', (code) => {
    const f = classifyOperatorError(httpError(503, code));
    expect(f.reasonKey).toBe(`operator.reason.${code}`);
    expect(f.retry).toBe('auto_once');
  });

  it.each(WAIT_DOC_CODES)('429 %s: wait for Retry-After', (code) => {
    const f = classifyOperatorError(httpError(429, code, { 'retry-after': '42' }));
    expect(f).toMatchObject({ reasonKey: `operator.reason.${code}`, retry: 'wait', retryAfterSec: 42 });
  });

  it('the table covers exactly the documented codes', () => {
    const documented = [...VERDICT_DOC_CODES, ...TRANSIENT_DOC_CODES, ...WAIT_DOC_CODES].sort();
    expect([...OPERATOR_ERROR_CODES].sort()).toEqual(documented);
  });

  it('every reason (codes and generic fallbacks) has text in uz, ru and en', () => {
    const reasons = [...OPERATOR_ERROR_CODES, ...GENERIC_REASONS];
    for (const reason of reasons) {
      for (const catalog of [uz, ru, en]) {
        expect(String(reasonOf(catalog, `operator.reason.${reason}`) ?? ''), reason).not.toBe('');
      }
    }
  });
});

describe('classifyOperatorError: transport and fallbacks', () => {
  it('network failure: manual retry', () => {
    const f = classifyOperatorError(new AxiosError('Network Error', 'ERR_NETWORK'));
    expect(f).toMatchObject({ reasonKey: 'operator.reason.network', retry: 'manual', code: null });
  });

  it('plain 429 (throttle): wait, Retry-After optional', () => {
    expect(classifyOperatorError(httpError(429, undefined, { 'retry-after': '7' }))).toMatchObject({ reasonKey: 'operator.reason.throttled', retry: 'wait', retryAfterSec: 7 });
    expect(classifyOperatorError(httpError(429)).retryAfterSec).toBeNull();
  });

  it('403 without a known code: access no longer allowed', () => {
    expect(classifyOperatorError(httpError(403)).reasonKey).toBe('operator.reason.forbidden');
    expect(classifyOperatorError(httpError(403, 'something_new')).reasonKey).toBe('operator.reason.forbidden');
  });

  it('an unknown 422 is a generic validation refusal; an unknown 4xx stays a safe red', () => {
    expect(classifyOperatorError(httpError(422, 'brand_new_rule'))).toMatchObject({ reasonKey: 'operator.reason.validation', retry: 'none', code: null });
    expect(classifyOperatorError(httpError(422))).toMatchObject({ reasonKey: 'operator.reason.validation' });
    expect(classifyOperatorError(httpError(409, 'brand_new_rule')).reasonKey).toBe('operator.reason.generic');
    expect(classifyOperatorError(httpError(400)).reasonKey).toBe('operator.reason.generic');
  });

  it('401 / 404 / 5xx / unknown 4xx / garbage', () => {
    expect(classifyOperatorError(httpError(401)).reasonKey).toBe('operator.reason.unauthorized');
    expect(classifyOperatorError(httpError(404)).reasonKey).toBe('operator.reason.not_found');
    expect(classifyOperatorError(httpError(502))).toMatchObject({ reasonKey: 'operator.reason.server', retry: 'manual' });
    expect(classifyOperatorError(httpError(503))).toMatchObject({ reasonKey: 'operator.reason.unavailable', retry: 'manual' });
    expect(classifyOperatorError(httpError(418, 'teapot')).reasonKey).toBe('operator.reason.generic');
    expect(classifyOperatorError(new Error('boom')).reasonKey).toBe('operator.reason.generic');
  });

  it('a malformed 2xx body is an unclear result, never retried', () => {
    expect(classifyOperatorError(new ContractError('check-in'))).toMatchObject({ reasonKey: 'operator.reason.contract', retry: 'none' });
  });

  it('never surfaces backend detail text', () => {
    const f = classifyOperatorError(httpError(409, 'plate_mismatch'));
    expect(JSON.stringify(f)).not.toContain('secret detail');
  });

  it('a prototype-ish code does not match a rule', () => {
    expect(classifyOperatorError(httpError(400, 'constructor')).reasonKey).toBe('operator.reason.generic');
  });
});

describe('parseRetryAfter', () => {
  it.each([
    ['30', 30],
    ['1', 1],
    ['99999', 3600],
    [' 12 ', 12],
  ])('%j -> %i', (raw, expected) => expect(parseRetryAfter(raw)).toBe(expected));

  it.each([undefined, '', '0', '-5', 'abc', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT', 12])('%j -> null', (raw) => {
    expect(parseRetryAfter(raw)).toBeNull();
  });
});

describe('withAutoRetry', () => {
  it('repeats once after a 503 serialization_retry', async () => {
    const task = vi.fn().mockRejectedValueOnce(httpError(503, 'serialization_retry')).mockResolvedValueOnce('ok');
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(withAutoRetry(task, wait)).resolves.toBe('ok');
    expect(task).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(AUTO_RETRY_DELAY_MS);
  });

  it('gives up after the second failure', async () => {
    const error = httpError(503, 'lock_timeout');
    const task = vi.fn().mockRejectedValue(error);
    await expect(withAutoRetry(task, async () => undefined)).rejects.toBe(error);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('does not repeat business refusals or network errors', async () => {
    for (const error of [httpError(409, 'already_used'), new AxiosError('x', 'ERR_NETWORK')]) {
      const task = vi.fn().mockRejectedValue(error);
      await expect(withAutoRetry(task, async () => undefined)).rejects.toBe(error);
      expect(task).toHaveBeenCalledTimes(1);
    }
  });

  it('passes success through untouched', async () => {
    const task = vi.fn().mockResolvedValue(5);
    await expect(withAutoRetry(task)).resolves.toBe(5);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
