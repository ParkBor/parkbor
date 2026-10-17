import { describe, expect, it } from 'vitest';

import {
  MAX_ACCURACY_M,
  MIN_INTERVAL_MS,
  OFF_ROUTE_M,
  createRerouteGate,
  pickAlternative,
  type AlternativeCandidate,
} from '@/features/route/rerouting';

const off = (now: number, over: Partial<{ distanceM: number; accuracyM: number | null }> = {}) => ({
  distanceM: OFF_ROUTE_M + 10,
  accuracyM: 10 as number | null,
  nowMs: now,
  ...over,
});

/** Feeds enough off-route fixes to trigger a request at (or after) `now`. */
function trigger(gate: ReturnType<typeof createRerouteGate>, now: number): boolean {
  gate.onFix(off(now));
  return gate.onFix(off(now + 1));
}

describe('createRerouteGate', () => {
  it('needs consecutive off-route fixes, not a single one', () => {
    const gate = createRerouteGate();
    expect(gate.onFix(off(MIN_INTERVAL_MS))).toBe(false);
    expect(gate.onFix(off(MIN_INTERVAL_MS + 1000))).toBe(true);
  });

  it('uses a strict 50 m threshold', () => {
    const gate = createRerouteGate();
    gate.onFix(off(100_000, { distanceM: OFF_ROUTE_M }));
    expect(gate.onFix(off(101_000, { distanceM: OFF_ROUTE_M }))).toBe(false);
    gate.onFix(off(102_000, { distanceM: OFF_ROUTE_M + 0.5 }));
    expect(gate.onFix(off(103_000, { distanceM: OFF_ROUTE_M + 0.5 }))).toBe(true);
  });

  it('resets the streak when a fix is back on the route', () => {
    const gate = createRerouteGate();
    gate.onFix(off(100_000));
    gate.onFix(off(101_000, { distanceM: 5 }));
    expect(gate.onFix(off(102_000))).toBe(false);
  });

  it('ignores inaccurate fixes: they neither count nor reset', () => {
    const gate = createRerouteGate();
    gate.onFix(off(100_000));
    expect(gate.onFix(off(101_000, { accuracyM: MAX_ACCURACY_M + 1 }))).toBe(false);
    expect(gate.onFix(off(102_000, { accuracyM: null }))).toBe(false);
    expect(gate.onFix(off(103_000))).toBe(true);
  });

  it('does not request twice within the minimum interval', () => {
    const gate = createRerouteGate();
    expect(trigger(gate, 100_000)).toBe(true);
    gate.onRequestStarted(100_002);
    gate.onResult('ok', 100_500);
    gate.onFix(off(101_000));
    expect(gate.onFix(off(102_000))).toBe(false);
    gate.onFix(off(100_002 + MIN_INTERVAL_MS));
    expect(gate.onFix(off(100_003 + MIN_INTERVAL_MS))).toBe(true);
  });

  it('never requests while a request is in flight', () => {
    const gate = createRerouteGate();
    expect(trigger(gate, 100_000)).toBe(true);
    gate.onRequestStarted(100_002);
    gate.onFix(off(200_000));
    expect(gate.onFix(off(201_000))).toBe(false);
  });

  it('backs off exponentially after a throttle response and recovers on success', () => {
    const gate = createRerouteGate();
    trigger(gate, 100_000);
    gate.onRequestStarted(100_000);
    gate.onResult('throttled', 100_100);
    const first = gate.nextAllowedAt();
    expect(first - 100_100).toBeGreaterThanOrEqual(60_000);

    gate.onRequestStarted(first);
    gate.onResult('throttled', first + 100);
    const second = gate.nextAllowedAt();
    expect(second - (first + 100)).toBeGreaterThan(first - 100_100);

    // Not allowed before the backoff ends, allowed after.
    gate.onFix(off(first + 1000));
    expect(gate.onFix(off(first + 2000))).toBe(false);
    gate.onFix(off(second));
    expect(gate.onFix(off(second + 1))).toBe(true);

    gate.onRequestStarted(second + 1);
    gate.onResult('ok', second + 200);
    expect(gate.nextAllowedAt() - (second + 1)).toBe(MIN_INTERVAL_MS);
  });

  it('caps the backoff', () => {
    const gate = createRerouteGate();
    let now = 0;
    for (let i = 0; i < 20; i += 1) {
      gate.onRequestStarted(now);
      gate.onResult('throttled', now);
      now = gate.nextAllowedAt();
    }
    gate.onRequestStarted(now);
    gate.onResult('throttled', now);
    expect(gate.nextAllowedAt() - now).toBeLessThanOrEqual(5 * 60_000);
  });

  it('also backs off after a generic failure (shorter than throttle)', () => {
    const gate = createRerouteGate();
    gate.onRequestStarted(0);
    gate.onResult('error', 100);
    expect(gate.nextAllowedAt() - 100).toBeGreaterThanOrEqual(MIN_INTERVAL_MS);
    expect(gate.nextAllowedAt() - 100).toBeLessThan(60_000);
  });

  it('reset() clears the streak and backoff', () => {
    const gate = createRerouteGate();
    gate.onRequestStarted(0);
    gate.onResult('throttled', 0);
    gate.reset();
    expect(gate.nextAllowedAt()).toBe(0);
  });
});

describe('pickAlternative', () => {
  const lot = (over: Partial<AlternativeCandidate>): AlternativeCandidate => ({
    id: 'a',
    name: 'A',
    freeSlots: 5,
    isOpen: true,
    location: { lat: 41.3, lng: 69.2 },
    ...over,
  });
  const here = { lat: 41.3, lng: 69.2 };

  it('picks the nearest open lot with free spots, excluding the selected one', () => {
    const picked = pickAlternative(
      [
        lot({ id: 'sel', location: { lat: 41.3001, lng: 69.2 } }),
        lot({ id: 'closed', isOpen: false, location: { lat: 41.3002, lng: 69.2 } }),
        lot({ id: 'full', freeSlots: 0, location: { lat: 41.3003, lng: 69.2 } }),
        lot({ id: 'far', location: { lat: 41.31, lng: 69.2 } }),
        lot({ id: 'near', location: { lat: 41.302, lng: 69.2 } }),
      ],
      'sel',
      here,
    );
    expect(picked?.lot.id).toBe('near');
    expect(picked?.distanceM).toBeGreaterThan(200);
  });

  it('returns null when nothing qualifies', () => {
    expect(pickAlternative([], 'sel', here)).toBeNull();
    expect(pickAlternative([lot({ id: 'sel' })], 'sel', here)).toBeNull();
  });
});
