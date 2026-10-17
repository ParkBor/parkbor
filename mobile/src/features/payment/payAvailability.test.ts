import { describe, expect, it } from 'vitest';

import { payAvailability, type PayableBooking } from '@/features/payment/payAvailability';

const NOW = 1_000_000;
const URL_OK = 'https://checkout.paycom.uz/abc';

const base: PayableBooking = {
  status: 'PENDING_PAYMENT',
  paymentUrl: URL_OK,
  isPaymentUrlInvalid: false,
  holdExpiresAtMs: NOW + 60_000,
};

describe('payAvailability', () => {
  it('is ready with a valid URL and a live hold', () => {
    expect(payAvailability(base, NOW)).toEqual({ kind: 'ready', url: URL_OK });
  });

  it('is ready when the server gave a URL but no hold timestamp', () => {
    expect(payAvailability({ ...base, holdExpiresAtMs: null }, NOW).kind).toBe('ready');
  });

  it.each(['CONFIRMED', 'ACTIVE', 'OVERSTAY', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'NO_SHOW', 'unknown'] as const)(
    '%s is not payable',
    (status) => {
      expect(payAvailability({ ...base, status }, NOW).kind).toBe('not_pending');
    },
  );

  it('the hold has run out (exactly now counts as over)', () => {
    expect(payAvailability({ ...base, holdExpiresAtMs: NOW }, NOW).kind).toBe('hold_over');
    expect(payAvailability({ ...base, holdExpiresAtMs: NOW - 1 }, NOW).kind).toBe('hold_over');
    expect(payAvailability({ ...base, holdExpiresAtMs: NOW + 1 }, NOW).kind).toBe('ready');
  });

  it('hold over wins over a missing url (the reason the user sees is the real one)', () => {
    expect(payAvailability({ ...base, holdExpiresAtMs: NOW - 1, paymentUrl: null }, NOW).kind).toBe('hold_over');
  });

  it('no URL: payment is not available', () => {
    expect(payAvailability({ ...base, paymentUrl: null }, NOW).kind).toBe('no_url');
  });

  it('a URL the app refused: distinct "invalid" state, never opened', () => {
    expect(payAvailability({ ...base, paymentUrl: null, isPaymentUrlInvalid: true }, NOW).kind).toBe('invalid_url');
  });

  it('re-checks the URL at the moment of opening (defence in depth)', () => {
    expect(payAvailability({ ...base, paymentUrl: 'https://evil.com/x' }, NOW).kind).toBe('invalid_url');
    expect(payAvailability({ ...base, paymentUrl: 'http://checkout.paycom.uz/x' }, NOW).kind).toBe('invalid_url');
  });

  it('a broken (NaN) clock does not invent an expired hold: the server stays the judge', () => {
    expect(payAvailability(base, Number.NaN).kind).toBe('ready');
  });
});
