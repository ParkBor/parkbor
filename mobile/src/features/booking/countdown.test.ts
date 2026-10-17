import { describe, expect, it } from 'vitest';

import { deriveCountdown, formatRemaining, type CountdownSource } from '@/features/booking/countdown';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 15, 9, 0, 0);

function source(overrides: Partial<CountdownSource>): CountdownSource {
  return {
    status: 'CONFIRMED',
    startMs: NOW + 2 * HOUR,
    endMs: NOW + 4 * HOUR,
    holdExpiresAtMs: null,
    ...overrides,
  };
}

describe('deriveCountdown', () => {
  it('PENDING_PAYMENT counts down to the hold expiry', () => {
    const result = deriveCountdown(source({ status: 'PENDING_PAYMENT', holdExpiresAtMs: NOW + 9 * MIN }), NOW);
    expect(result).toEqual({ kind: 'hold', remainingMs: 9 * MIN, isOver: false });
  });

  it('an expired hold is flagged, never negative', () => {
    const result = deriveCountdown(source({ status: 'PENDING_PAYMENT', holdExpiresAtMs: NOW - 5 * SEC }), NOW);
    expect(result).toEqual({ kind: 'hold', remainingMs: 0, isOver: true });
  });

  it('PENDING_PAYMENT without a hold time shows nothing', () => {
    expect(deriveCountdown(source({ status: 'PENDING_PAYMENT' }), NOW).kind).toBe('none');
  });

  it('CONFIRMED before the start counts down to the start', () => {
    expect(deriveCountdown(source({}), NOW)).toEqual({ kind: 'untilStart', remainingMs: 2 * HOUR, isOver: false });
  });

  it('CONFIRMED after the start shows the grace time to the end', () => {
    expect(deriveCountdown(source({ startMs: NOW - 10 * MIN }), NOW)).toEqual({
      kind: 'untilEnd',
      remainingMs: 4 * HOUR,
      isOver: false,
    });
  });

  it('ACTIVE counts down to the end and flags overtime', () => {
    expect(deriveCountdown(source({ status: 'ACTIVE' }), NOW)).toEqual({ kind: 'untilEnd', remainingMs: 4 * HOUR, isOver: false });
    expect(deriveCountdown(source({ status: 'ACTIVE', endMs: NOW - MIN }), NOW)).toEqual({
      kind: 'untilEnd',
      remainingMs: 0,
      isOver: true,
    });
  });

  it('OVERSTAY is over by definition', () => {
    expect(deriveCountdown(source({ status: 'OVERSTAY', endMs: NOW - HOUR }), NOW)).toEqual({
      kind: 'untilEnd',
      remainingMs: 0,
      isOver: true,
    });
  });

  it.each(['COMPLETED', 'CANCELLED', 'EXPIRED', 'NO_SHOW', 'unknown'] as const)('%s has no countdown', (status) => {
    expect(deriveCountdown(source({ status }), NOW).kind).toBe('none');
  });
});

describe('formatRemaining', () => {
  it('uses m:ss under an hour', () => {
    expect(formatRemaining(9 * MIN + 5 * SEC, 'en')).toBe('9:05');
    expect(formatRemaining(59 * SEC, 'en')).toBe('0:59');
    expect(formatRemaining(0, 'en')).toBe('0:00');
  });

  it('rounds partial seconds up so 0:00 only appears at the real end', () => {
    expect(formatRemaining(500, 'en')).toBe('0:01');
  });

  it('uses h:mm:ss under a day, in every language the same clock form', () => {
    expect(formatRemaining(HOUR + 5 * MIN + 9 * SEC, 'uz')).toBe('1:05:09');
    expect(formatRemaining(23 * HOUR + 59 * MIN + 59 * SEC, 'ru')).toBe('23:59:59');
  });

  it('switches to days and hours beyond 24 h with locale units', () => {
    const span = 3 * 24 * HOUR + 4 * HOUR + 30 * MIN;
    expect(formatRemaining(span, 'en')).toBe('3 d 4 h');
    expect(formatRemaining(span, 'ru')).toBe('3 д 4 ч');
    expect(formatRemaining(span, 'uz')).toBe('3 kun 4 soat');
    expect(formatRemaining(24 * HOUR, 'en')).toBe('1 d 0 h');
  });

  it('is safe for invalid input', () => {
    expect(formatRemaining(Number.NaN, 'en')).toBe('0:00');
    expect(formatRemaining(-5000, 'en')).toBe('0:00');
    expect(formatRemaining(Number.POSITIVE_INFINITY, 'en')).toBe('0:00');
  });
});
