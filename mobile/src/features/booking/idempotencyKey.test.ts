import { describe, expect, it } from 'vitest';

import {
  bindKeeperToSession,
  bookingFingerprint,
  createIdempotencyKeeper,
  IDEMPOTENCY_KEY_PATTERN,
  type CreateBookingPayload,
} from '@/features/booking/idempotencyKey';

const LOT = 'b2f0c1de-1111-4222-8333-444455556666';
const VEHICLE = 'a91c1de0-1111-4222-8333-444455556666';
const START = Date.UTC(2026, 9, 15, 9, 0, 0);

const payload: CreateBookingPayload = {
  parkingLotId: LOT,
  slotType: 'STANDARD',
  vehicleId: VEHICLE,
  startMs: START,
  endMs: START + 2 * 3_600_000,
  preferredSlotId: null,
  paymentProvider: null,
};

function counter() {
  let n = 0;
  return () => `key-${String(++n).padStart(8, '0')}`;
}

describe('createIdempotencyKeeper', () => {
  it('returns the SAME key for the same payload (double tap, retry after an error)', () => {
    const keeper = createIdempotencyKeeper(counter());
    const first = keeper.keyFor(bookingFingerprint(payload));
    const second = keeper.keyFor(bookingFingerprint({ ...payload }));
    expect(second).toBe(first);
  });

  it('issues a NEW key when the payload changes', () => {
    const keeper = createIdempotencyKeeper(counter());
    const first = keeper.keyFor(bookingFingerprint(payload));
    const other = keeper.keyFor(bookingFingerprint({ ...payload, endMs: payload.endMs + 15 * 60_000 }));
    expect(other).not.toBe(first);
  });

  it('after a change, going back does not resurrect the old key', () => {
    const keeper = createIdempotencyKeeper(counter());
    const first = keeper.keyFor('a');
    keeper.keyFor('b');
    expect(keeper.keyFor('a')).not.toBe(first);
  });

  it('release() after success makes the next attempt use a fresh key', () => {
    const keeper = createIdempotencyKeeper(counter());
    const first = keeper.keyFor('a');
    keeper.release();
    expect(keeper.keyFor('a')).not.toBe(first);
  });

  it('rotate() forces a new key for an unchanged payload (idempotency_conflict)', () => {
    const keeper = createIdempotencyKeeper(counter());
    const first = keeper.keyFor('a');
    keeper.rotate();
    expect(keeper.keyFor('a')).not.toBe(first);
  });

  it('refuses a generator that breaks the server key format', () => {
    for (const bad of ['short', 'has space in it', 'x'.repeat(129), 'ключ-ключ-ключ']) {
      const keeper = createIdempotencyKeeper(() => bad);
      expect(() => keeper.keyFor('a'), bad).toThrow(RangeError);
    }
  });

  it('accepts UUIDs and the documented alphabet', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('7c1e2f3a-1111-4222-8333-444455556666')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('a_b.c:d-eeee')).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('x'.repeat(8))).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test('x'.repeat(7))).toBe(false);
  });
});

describe('bookingFingerprint', () => {
  it('is stable and ignores sub-minute noise (the server drops seconds)', () => {
    expect(bookingFingerprint(payload)).toBe(bookingFingerprint({ ...payload, startMs: START + 30_000 }));
  });

  it('changes with every field that matters', () => {
    const base = bookingFingerprint(payload);
    const variants: CreateBookingPayload[] = [
      { ...payload, parkingLotId: VEHICLE },
      { ...payload, slotType: 'EV' },
      { ...payload, vehicleId: LOT },
      { ...payload, startMs: START + 15 * 60_000 },
      { ...payload, endMs: payload.endMs + 15 * 60_000 },
      { ...payload, preferredSlotId: LOT },
      { ...payload, paymentProvider: 'payme' },
      { ...payload, paymentProvider: 'click' },
    ];
    for (const variant of variants) expect(bookingFingerprint(variant)).not.toBe(base);
  });

  it('a different payment provider is a different attempt (the server fingerprint includes it)', () => {
    const payme = bookingFingerprint({ ...payload, paymentProvider: 'payme' });
    const click = bookingFingerprint({ ...payload, paymentProvider: 'click' });
    expect(payme).not.toBe(click);
    expect(payme).toBe(bookingFingerprint({ ...payload, paymentProvider: 'payme' }));
    expect(bookingFingerprint(payload)).not.toBe(payme);
  });

  it('switching provider renews the Idempotency-Key, switching back does not resurrect the old one', () => {
    const keeper = createIdempotencyKeeper(counter());
    const first = keeper.keyFor(bookingFingerprint({ ...payload, paymentProvider: 'payme' }));
    const second = keeper.keyFor(bookingFingerprint({ ...payload, paymentProvider: 'click' }));
    expect(second).not.toBe(first);
    expect(keeper.keyFor(bookingFingerprint({ ...payload, paymentProvider: 'payme' }))).not.toBe(first);
  });

  it('the same provider keeps the same key (double tap)', () => {
    const keeper = createIdempotencyKeeper(counter());
    const first = keeper.keyFor(bookingFingerprint({ ...payload, paymentProvider: 'click' }));
    expect(keeper.keyFor(bookingFingerprint({ ...payload, paymentProvider: 'click' }))).toBe(first);
  });

  it('does not leak identifiers into a readable log line', () => {
    // The fingerprint is compared in memory only; it must still never be a JSON blob of raw ids
    // that someone might print. It is a short opaque hash string.
    expect(bookingFingerprint(payload)).toMatch(/^[0-9a-f]{8,}$/);
  });
});

describe('app-wide keeper', () => {
  it('survives the screen: another consumer asking for the same attempt gets the same key', () => {
    const keeper = createIdempotencyKeeper(counter());
    const fromFirstMount = keeper.keyFor('attempt');
    const fromSecondMount = keeper.keyFor('attempt');
    expect(fromSecondMount).toBe(fromFirstMount);
  });

  it('is renewed when the session ends', () => {
    let listener: ((s: { status: string; user: { id: string } | null }) => void) | undefined;
    const keeper = createIdempotencyKeeper(counter());
    bindKeeperToSession(keeper, {
      getState: () => ({ status: 'authenticated', user: { id: '1' } }),
      subscribe: (l) => {
        listener = l;
        return () => undefined;
      },
    });
    const before = keeper.keyFor('attempt');
    listener?.({ status: 'anonymous', user: null });
    expect(keeper.keyFor('attempt')).not.toBe(before);
  });
});
