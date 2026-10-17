import { describe, expect, it } from 'vitest';

import { MIN_INTERVAL_MS, createRerouteGate } from '@/features/route/rerouting';

const SECOND = 1000;

describe('fallback (approximate route) re-requests', () => {
  it('re-asks every 15 s while moving but only every 45 s while standing still', () => {
    const gate = createRerouteGate();
    expect(gate.onApproximateFix({ accuracyM: 8, isMoving: true, nowMs: 100_000 })).toBe(true);
    gate.onRequestStarted(100_000);
    gate.onResult('fallback', 100_300);

    expect(gate.onApproximateFix({ accuracyM: 8, isMoving: true, nowMs: 100_000 + 5 * SECOND })).toBe(false);
    expect(gate.onApproximateFix({ accuracyM: 8, isMoving: true, nowMs: 100_000 + MIN_INTERVAL_MS })).toBe(true);
    expect(gate.onApproximateFix({ accuracyM: 8, isMoving: false, nowMs: 100_000 + MIN_INTERVAL_MS })).toBe(false);
    expect(gate.onApproximateFix({ accuracyM: 8, isMoving: false, nowMs: 100_000 + 45 * SECOND })).toBe(true);
  });

  it('never asks while a request is in flight or with an unusable fix', () => {
    const gate = createRerouteGate();
    gate.onRequestStarted(0);
    expect(gate.onApproximateFix({ accuracyM: 8, isMoving: true, nowMs: 600_000 })).toBe(false);
    gate.onResult('fallback', 600_000);
    expect(gate.onApproximateFix({ accuracyM: null, isMoving: true, nowMs: 900_000 })).toBe(false);
    expect(gate.onApproximateFix({ accuracyM: 500, isMoving: true, nowMs: 900_000 })).toBe(false);
  });

  it('consecutive fallback answers back off softly up to 60 s', () => {
    const gate = createRerouteGate();
    let now = 0;
    const waits: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      gate.onRequestStarted(now);
      gate.onResult('fallback', now);
      waits.push(gate.nextAllowedAt() - now);
      now = gate.nextAllowedAt();
    }
    expect(waits).toEqual([15_000, 30_000, 60_000, 60_000, 60_000]);
  });

  it('a real (osrm) answer resets the soft backoff', () => {
    const gate = createRerouteGate();
    let now = 0;
    for (let i = 0; i < 3; i += 1) {
      gate.onRequestStarted(now);
      gate.onResult('fallback', now);
      now = gate.nextAllowedAt();
    }
    gate.onRequestStarted(now);
    gate.onResult('ok', now);
    gate.onRequestStarted(now);
    gate.onResult('fallback', now);
    expect(gate.nextAllowedAt() - now).toBe(MIN_INTERVAL_MS);
  });

  it('a fallback answer does not clear an error backoff that is still running', () => {
    const gate = createRerouteGate();
    gate.onRequestStarted(0);
    gate.onResult('throttled', 0);
    const blockedUntil = gate.nextAllowedAt();
    expect(blockedUntil).toBeGreaterThanOrEqual(60_000);
    gate.onRequestStarted(1000);
    gate.onResult('fallback', 1000);
    expect(gate.nextAllowedAt()).toBeGreaterThanOrEqual(blockedUntil);
  });

  it('reset() forgets the fallback streak', () => {
    const gate = createRerouteGate();
    gate.onRequestStarted(0);
    gate.onResult('fallback', 0);
    gate.onRequestStarted(gate.nextAllowedAt());
    gate.onResult('fallback', gate.nextAllowedAt());
    gate.reset();
    gate.onRequestStarted(1000);
    gate.onResult('fallback', 1000);
    expect(gate.nextAllowedAt() - 1000).toBe(MIN_INTERVAL_MS);
  });
});

describe('isPending', () => {
  it('is true between a started request and its reported outcome', () => {
    const gate = createRerouteGate();
    expect(gate.isPending()).toBe(false);
    gate.onRequestStarted(0);
    expect(gate.isPending()).toBe(true);
    gate.onResult('ok', 10);
    expect(gate.isPending()).toBe(false);
  });
});
