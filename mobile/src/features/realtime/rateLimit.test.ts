import { describe, expect, it } from 'vitest';

import { BUCKET_CAPACITY, createTokenBucket } from '@/features/realtime/rateLimit';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('token bucket (mirrors the server, with headroom)', () => {
  it('starts full and refuses what it cannot pay', () => {
    const c = clock();
    const bucket = createTokenBucket(c.now);
    expect(bucket.take(BUCKET_CAPACITY)).toBe(true);
    expect(bucket.take(1)).toBe(false);
  });

  it('refills over time, never above capacity', () => {
    const c = clock();
    const bucket = createTokenBucket(c.now);
    bucket.take(BUCKET_CAPACITY);
    c.advance(500);
    expect(bucket.take(BUCKET_CAPACITY / 2)).toBe(true);
    expect(bucket.take(1)).toBe(false);
    c.advance(60_000);
    expect(bucket.take(BUCKET_CAPACITY)).toBe(true);
    expect(bucket.take(1)).toBe(false);
  });

  it('caps the cost of a single message at the capacity so it can always pass', () => {
    const c = clock();
    const bucket = createTokenBucket(c.now);
    expect(bucket.take(999)).toBe(true);
  });

  it('reports how long until a message can be paid for', () => {
    const c = clock();
    const bucket = createTokenBucket(c.now);
    bucket.take(BUCKET_CAPACITY);
    expect(bucket.waitMs(1)).toBeGreaterThan(0);
    expect(bucket.waitMs(1)).toBeLessThanOrEqual(1000);
    c.advance(2000);
    expect(bucket.waitMs(1)).toBe(0);
  });

  it('tolerates a clock that goes backwards', () => {
    const c = clock(10_000);
    const bucket = createTokenBucket(c.now);
    bucket.take(BUCKET_CAPACITY);
    c.advance(-5000);
    expect(bucket.take(1)).toBe(false);
  });
});
