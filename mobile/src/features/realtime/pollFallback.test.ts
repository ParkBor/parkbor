import { describe, expect, it } from 'vitest';

import {
  LIVE_SAFETY_POLL_MS,
  PENDING_PAYMENT_SAFETY_POLL_MS,
  bookingPollInterval,
  relaxWhenLive,
} from '@/features/realtime/pollFallback';

describe('relaxWhenLive', () => {
  it('keeps the normal interval while the socket is down', () => {
    expect(relaxWhenLive(15_000, false)).toBe(15_000);
    expect(relaxWhenLive(2500, false)).toBe(2500);
  });

  it('slows polling to the safety net while live (never beyond 30 s: events can be lost)', () => {
    expect(relaxWhenLive(15_000, true)).toBe(LIVE_SAFETY_POLL_MS);
    expect(LIVE_SAFETY_POLL_MS).toBeLessThanOrEqual(30_000);
  });

  it('never makes polling faster than it was', () => {
    expect(relaxWhenLive(120_000, true)).toBe(120_000);
  });

  it('keeps "no polling" as it is', () => {
    expect(relaxWhenLive(false, true)).toBe(false);
    expect(relaxWhenLive(false, false)).toBe(false);
  });
});

describe('bookingPollInterval', () => {
  const base = { isChangeable: true, status: 'CONFIRMED', pollMs: 15_000, isExplicit: false, isRealtimeLive: true };

  it('does not poll a booking that can no longer change', () => {
    expect(bookingPollInterval({ ...base, isChangeable: false })).toBe(false);
    expect(bookingPollInterval({ ...base, isChangeable: false, isRealtimeLive: false })).toBe(false);
  });

  it('polls at the caller interval while the socket is down', () => {
    expect(bookingPollInterval({ ...base, isRealtimeLive: false })).toBe(15_000);
  });

  it('relaxes a detail screen to 30 s at most while live', () => {
    expect(bookingPollInterval(base)).toBe(30_000);
  });

  it('keeps PENDING_PAYMENT at 15 s while live', () => {
    expect(bookingPollInterval({ ...base, status: 'PENDING_PAYMENT' })).toBe(PENDING_PAYMENT_SAFETY_POLL_MS);
    expect(PENDING_PAYMENT_SAFETY_POLL_MS).toBeLessThanOrEqual(15_000);
  });

  it('never relaxes an explicit interval (the payment screen polls every few seconds)', () => {
    expect(bookingPollInterval({ ...base, status: 'PENDING_PAYMENT', pollMs: 5000, isExplicit: true })).toBe(5000);
  });

  it('does not go faster than the requested interval', () => {
    expect(bookingPollInterval({ ...base, pollMs: 90_000 })).toBe(90_000);
  });
});
