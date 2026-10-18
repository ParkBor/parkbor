import { describe, expect, it } from 'vitest';

import {
  BACKOFF_BASE_MS,
  BACKOFF_JITTER,
  BACKOFF_MAX_MS,
  IMMEDIATE_RECONNECT_MS,
  backoffDelay,
} from '@/features/realtime/backoff';

describe('backoffDelay', () => {
  it('starts at 1 s and doubles per attempt (no jitter at random = 0.5)', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000]);
  });

  it('caps the base at 60 s', () => {
    expect(backoffDelay(20, 0.5)).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(1000, 0.5)).toBe(BACKOFF_MAX_MS);
  });

  it('spreads by +-30 %', () => {
    expect(backoffDelay(0, 0)).toBe(Math.round(BACKOFF_BASE_MS * (1 - BACKOFF_JITTER)));
    expect(backoffDelay(0, 1)).toBe(Math.round(BACKOFF_BASE_MS * (1 + BACKOFF_JITTER)));
    expect(backoffDelay(3, 0)).toBe(5600);
  });

  it('treats a negative, fractional or NaN attempt sanely', () => {
    expect(backoffDelay(-3, 0.5)).toBe(1000);
    expect(backoffDelay(Number.NaN, 0.5)).toBe(1000);
    expect(backoffDelay(1.9, 0.5)).toBe(2000);
  });

  it('clamps a random value outside [0,1]', () => {
    expect(backoffDelay(0, 5)).toBe(backoffDelay(0, 1));
    expect(backoffDelay(0, -5)).toBe(backoffDelay(0, 0));
  });

  it('has a short but non-zero delay for the max-age reconnect', () => {
    expect(IMMEDIATE_RECONNECT_MS).toBeGreaterThan(0);
    expect(IMMEDIATE_RECONNECT_MS).toBeLessThan(BACKOFF_BASE_MS);
  });
});
