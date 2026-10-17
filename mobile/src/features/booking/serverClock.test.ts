import { describe, expect, it } from 'vitest';

import { createServerClock, JUMP_MS, MAX_RTT_MS, MAX_SKEW_MS, type ClockSample } from '@/features/booking/serverClock';

const SERVER = Date.UTC(2026, 9, 15, 9, 0, 0);
const header = (ms: number): string => new Date(ms).toUTCString();

/** A response whose Date header says `serverMs` (second precision), measured on a device `skew` behind. */
function sample(serverMs: number, deviceBehindMs: number, rttMs = 100, extra: Partial<ClockSample> = {}): ClockSample {
  const midpoint = serverMs - deviceBehindMs;
  return { dateHeader: header(serverMs), sentAtMs: midpoint - rttMs / 2, receivedAtMs: midpoint + rttMs / 2, ...extra };
}

describe('createServerClock', () => {
  it('equals the device clock until a sample is observed', () => {
    const clock = createServerClock(() => 1_000_000);
    expect(clock.now()).toBe(1_000_000);
    expect(clock.skewMs()).toBe(0);
  });

  it('corrects a device clock that runs behind (midpoint of the request, +0.5 s for header truncation)', () => {
    let device = SERVER - 3 * 60_000;
    const clock = createServerClock(() => device);
    clock.observe(sample(SERVER, 3 * 60_000));
    expect(clock.skewMs()).toBe(3 * 60_000 + 500);
    device += 5_000;
    expect(clock.now()).toBe(SERVER + 5_000 + 500);
  });

  it('corrects a device clock that runs ahead', () => {
    const clock = createServerClock(() => SERVER + 10 * 60_000);
    clock.observe(sample(SERVER, -10 * 60_000));
    expect(clock.skewMs()).toBe(-10 * 60_000 + 500);
  });

  it('ignores a missing, malformed or absurd Date header', () => {
    const clock = createServerClock(() => 5_000);
    clock.observe({ dateHeader: undefined, sentAtMs: 0, receivedAtMs: 10 });
    clock.observe({ dateHeader: 'not a date', sentAtMs: 0, receivedAtMs: 10 });
    clock.observe({ dateHeader: header(SERVER), sentAtMs: 0, receivedAtMs: 10 });
    expect(clock.skewMs()).toBe(0);
    expect(MAX_SKEW_MS).toBe(24 * 3_600_000);
  });

  it('ignores a cached response (Age header)', () => {
    const clock = createServerClock(() => SERVER);
    clock.observe(sample(SERVER - 120_000, 0, 100, { ageHeader: '120' }));
    expect(clock.skewMs()).toBe(0);
  });

  it('ignores impossible or very slow round trips', () => {
    const clock = createServerClock(() => SERVER);
    clock.observe({ dateHeader: header(SERVER), sentAtMs: SERVER + 50, receivedAtMs: SERVER });
    clock.observe(sample(SERVER, 0, MAX_RTT_MS + 1));
    expect(clock.skewMs()).toBe(0);
  });

  it('prefers the sample with the smallest round trip', () => {
    const clock = createServerClock(() => SERVER);
    clock.observe(sample(SERVER, 0, 2000)); // noisy
    const noisy = clock.skewMs();
    clock.observe(sample(SERVER, 1000, 50)); // tight, device 1 s behind
    expect(clock.skewMs()).toBe(1500);
    clock.observe(sample(SERVER, 0, 3000)); // worse again: kept as is
    expect(clock.skewMs()).toBe(1500);
    expect(noisy).toBe(500);
  });

  it('rejects a sudden jump until a second sample confirms it', () => {
    const clock = createServerClock(() => SERVER);
    clock.observe(sample(SERVER, 0));
    const base = clock.skewMs();
    clock.observe(sample(SERVER, JUMP_MS + 60_000)); // one odd sample (proxy, bad header)
    expect(clock.skewMs()).toBe(base);
    clock.observe(sample(SERVER, JUMP_MS + 60_000)); // the same again: the user changed the clock
    expect(clock.skewMs()).toBe(JUMP_MS + 60_000 + 500);
  });

  it('reset() forgets everything (logout / account switch)', () => {
    const clock = createServerClock(() => SERVER);
    clock.observe(sample(SERVER, 60_000));
    clock.reset();
    expect(clock.skewMs()).toBe(0);
  });
});
