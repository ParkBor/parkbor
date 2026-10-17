import { describe, expect, it } from 'vitest';

import {
  BOOKING_ID,
  LOT_ID,
  rawCheckIn,
  rawCheckOut,
  rawGateBooking,
  rawLot,
  rawLotPage,
  rawMapBooking,
  rawMapSlot,
  rawSlotMap,
  rawWalkIn,
  SLOT_ID,
} from '@/features/operator/fixtures';
import {
  parseCheckIn,
  parseCheckOut,
  parseInviteAccepted,
  parseLotPage,
  parseSlotMap,
  parseSlotPatched,
  parseWalkIn,
} from '@/features/operator/operatorSchemas';
import { ContractError } from '@/lib/contract';

describe('parseLotPage', () => {
  it('maps lots and the next-page flag', () => {
    const page = parseLotPage(rawLotPage([rawLot(), rawLot({ status: 'SUSPENDED', free_slots: 0 })], 'http://x/?page=2'));
    expect(page.hasNext).toBe(true);
    expect(page.results).toHaveLength(2);
    expect(page.results[0]).toMatchObject({ id: LOT_ID, name: 'Chorsu Parking', status: 'ACTIVE', totalSlots: 40, freeSlots: 12 });
    expect(page.results[1]?.status).toBe('SUSPENDED');
  });

  it('require_plate_on_checkin: bool from the server, false when absent', () => {
    expect(parseLotPage(rawLotPage([rawLot({ require_plate_on_checkin: true })])).results[0]?.requirePlateOnCheckin).toBe(true);
    const old = rawLot();
    delete old.require_plate_on_checkin;
    expect(parseLotPage(rawLotPage([old])).results[0]?.requirePlateOnCheckin).toBe(false);
    expect(parseLotPage(rawLotPage([rawLot({ require_plate_on_checkin: 'yes' })])).results[0]?.requirePlateOnCheckin).toBe(false);
  });

  it('turns a status this version does not know into "unknown" (never ACTIVE)', () => {
    expect(parseLotPage(rawLotPage([rawLot({ status: 'ARCHIVED' })])).results[0]?.status).toBe('unknown');
  });

  it('rejects malformed pages without echoing the content', () => {
    expect(() => parseLotPage({ results: 'nope' })).toThrow(ContractError);
    expect(() => parseLotPage(rawLotPage([rawLot({ id: 'not-a-uuid' })]))).toThrow(ContractError);
    expect(() => parseLotPage(null)).toThrow(ContractError);
    try {
      parseLotPage(rawLotPage([rawLot({ name: 12 })]));
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('12');
    }
  });
});

describe('parseSlotMap', () => {
  it('maps slots with current and next bookings', () => {
    const map = parseSlotMap(
      rawSlotMap([
        rawMapSlot({ status: 'OCCUPIED', current_booking: rawMapBooking({ kind: 'WALK_IN' }) }),
        rawMapSlot({ id: '99999999-2222-4333-8444-555555555555', code: 'A-13', status: 'RESERVED', next_booking: rawMapBooking({ plate_number: null, status: 'CONFIRMED' }) }),
      ]),
    );
    expect(map.truncated).toBe(false);
    expect(map.lot.id).toBe(LOT_ID);
    expect(map.slots[0]).toMatchObject({ id: SLOT_ID, code: 'A-12', status: 'OCCUPIED', type: 'STANDARD' });
    expect(map.slots[0]?.current).toMatchObject({ id: BOOKING_ID, kind: 'WALK_IN', plate: '01A123BC' });
    expect(map.slots[1]?.next?.plate).toBeNull();
  });

  it('keeps the truncated flag', () => {
    expect(parseSlotMap(rawSlotMap([], true)).truncated).toBe(true);
  });

  it('unknown slot status / type / booking kind degrade to "unknown"', () => {
    const map = parseSlotMap(
      rawSlotMap([rawMapSlot({ status: 'BROKEN', type: 'ROCKET', current_booking: rawMapBooking({ kind: 'FOO' }) })]),
    );
    expect(map.slots[0]?.status).toBe('unknown');
    expect(map.slots[0]?.type).toBe('unknown');
    expect(map.slots[0]?.current?.kind).toBe('unknown');
  });

  it('rejects a missing slots array', () => {
    expect(() => parseSlotMap({ parking_lot: rawLot(), truncated: false })).toThrow(ContractError);
  });

  it('rejects a naive (offset-less) timestamp', () => {
    expect(() => parseSlotMap(rawSlotMap([rawMapSlot({ current_booking: rawMapBooking({ start: '2026-10-17T09:00:00' }) })]))).toThrow(ContractError);
  });
});

describe('parseCheckIn', () => {
  it('maps a green admission', () => {
    const r = parseCheckIn(rawCheckIn());
    expect(r).toMatchObject({ allowed: true, result: 'checked_in' });
    expect(r.booking).toMatchObject({ plate: '01A123BC', kind: 'ONLINE', slot: { code: 'A-12', zone: 'A', floor: 1 } });
    expect(r.checkoutByMs).toBe(Date.parse('2026-10-17T11:00:00+05:00'));
  });

  it('maps the amber repeat scan', () => {
    expect(parseCheckIn(rawCheckIn({ allowed: false, result: 'already_checked_in' }))).toMatchObject({
      allowed: false,
      result: 'already_checked_in',
    });
  });

  it('an unknown result code becomes "unknown"', () => {
    expect(parseCheckIn(rawCheckIn({ result: 'teleported' })).result).toBe('unknown');
  });

  it('survives a missing "next" block', () => {
    expect(parseCheckIn(rawCheckIn({ next: undefined })).checkoutByMs).toBeNull();
  });

  it('rejects a non-boolean allowed and a broken booking', () => {
    expect(() => parseCheckIn(rawCheckIn({ allowed: 'yes' }))).toThrow(ContractError);
    expect(() => parseCheckIn(rawCheckIn({ booking: { id: 1 } }))).toThrow(ContractError);
  });
});

describe('parseCheckOut', () => {
  it('maps overstay and the amount to collect as exact strings', () => {
    const r = parseCheckOut(rawCheckOut());
    expect(r).toMatchObject({ result: 'completed', actualMinutes: 138, toCollect: '3000.00' });
    expect(r.overstay).toEqual({ minutes: 20, amount: '3000.00', status: 'due', needsReview: false });
  });

  it('refuses a money value sent as a JSON number', () => {
    expect(() => parseCheckOut(rawCheckOut({ to_collect: 3000 }))).toThrow(ContractError);
  });

  it('allowed: server value wins; absent -> derived from result (old servers)', () => {
    expect(parseCheckOut(rawCheckOut()).allowed).toBe(true);
    expect(parseCheckOut(rawCheckOut({ result: 'already_completed', allowed: false })).allowed).toBe(false);
    const legacy = rawCheckOut();
    delete legacy.allowed;
    expect(parseCheckOut(legacy).allowed).toBe(true);
    expect(parseCheckOut({ ...legacy, result: 'already_completed' }).allowed).toBe(false);
    expect(parseCheckOut({ ...legacy, result: 'weird' }).allowed).toBe(false);
  });

  it('allowed=true never turns an already_completed answer green', () => {
    expect(parseCheckOut(rawCheckOut({ result: 'already_completed', allowed: true })).allowed).toBe(false);
  });

  it('needs_review defaults to false and is kept when true', () => {
    expect(parseCheckOut(rawCheckOut()).overstay.needsReview).toBe(false);
    const raw = rawCheckOut({ overstay: { minutes: 9, amount: '9.00', status: 'due', needs_review: true } });
    expect(parseCheckOut(raw).overstay.needsReview).toBe(true);
    const old = rawCheckOut({ overstay: { minutes: 9, amount: '9.00', status: 'due' } });
    expect(parseCheckOut(old).overstay.needsReview).toBe(false);
  });

  it('needs_review is read from the BOOKING (overstay_needs_review) as the backend sends it, or from overstay', () => {
    const onBooking = rawCheckOut({ booking: rawGateBooking({ overstay_needs_review: true }) });
    expect(parseCheckOut(onBooking).overstay.needsReview).toBe(true);
    const both = rawCheckOut({ booking: rawGateBooking({ overstay_needs_review: false }), overstay: { minutes: 1, amount: '1.00', status: 'due', needs_review: true } });
    expect(parseCheckOut(both).overstay.needsReview).toBe(true);
    expect(parseCheckOut(rawCheckOut({ booking: rawGateBooking({ overstay_needs_review: 'x' }) })).overstay.needsReview).toBe(false);
  });

  it('a missing overstay block does not fail the answer (display only); to_collect stays mandatory', () => {
    const raw = rawCheckOut();
    delete raw.overstay;
    expect(parseCheckOut(raw).overstay).toEqual({ minutes: 0, amount: '0.00', status: 'unknown', needsReview: false });
    const noMoney = rawCheckOut();
    delete noMoney.to_collect;
    expect(() => parseCheckOut(noMoney)).toThrow(ContractError);
  });

  it('unknown result and overstay status degrade to "unknown"', () => {
    const r = parseCheckOut(rawCheckOut({ result: 'x', overstay: { minutes: 0, amount: '0.00', status: 'later' } }));
    expect(r.result).toBe('unknown');
    expect(r.overstay.status).toBe('unknown');
  });
});

describe('parseWalkIn / parseSlotPatched / parseInviteAccepted', () => {
  it('parses a walk-in registration', () => {
    const r = parseWalkIn(rawWalkIn());
    expect(r.result).toBe('registered');
    expect(r.booking.kind).toBe('WALK_IN');
    expect(r.validUntilMs).toBe(Date.parse('2026-10-17T21:00:00+05:00'));
  });

  it('an unknown walk-in result is not "registered"', () => {
    expect(parseWalkIn(rawWalkIn({ result: 'maybe' })).result).toBe('unknown');
  });

  it('parses the slot patch answer', () => {
    expect(parseSlotPatched({ id: SLOT_ID, code: 'A-12', status: 'OUT_OF_SERVICE', affected_bookings: 2 })).toEqual({
      id: SLOT_ID,
      code: 'A-12',
      status: 'OUT_OF_SERVICE',
      affectedBookings: 2,
    });
    expect(() => parseSlotPatched({ id: 'x' })).toThrow(ContractError);
  });

  it('parses the invite answer and keeps only the lot name and id', () => {
    expect(parseInviteAccepted({ parking_lot: { id: LOT_ID, name: 'Chorsu', extra: 'x' } })).toEqual({ lotId: LOT_ID, lotName: 'Chorsu' });
    expect(() => parseInviteAccepted({})).toThrow(ContractError);
  });

  it('display-only booking fields are soft: a surprise there must not turn a done admission into an error', () => {
    const odd = rawGateBooking({ start: 'garbage', end: null, slot: { id: SLOT_ID, code: 'A-12', zone: 5, floor: 'x' }, amount: 12 });
    const r = parseCheckIn(rawCheckIn({ booking: odd, next: { checkout_by: 'garbage' } }));
    expect(r.booking).toMatchObject({ plate: '01A123BC', slot: { code: 'A-12', zone: '', floor: 0 }, startMs: null, endMs: null, amount: null });
    expect(r.checkoutByMs).toBeNull();
  });

  it('the plate and the slot code are not soft', () => {
    expect(() => parseCheckIn(rawCheckIn({ booking: rawGateBooking({ plate_number: undefined }) }))).toThrow(ContractError);
    expect(() => parseCheckIn(rawCheckIn({ booking: rawGateBooking({ slot: { id: SLOT_ID } }) }))).toThrow(ContractError);
  });

  it('a gate booking needs only the documented fields (optional money may be absent)', () => {
    const minimal = rawGateBooking();
    delete minimal.amount;
    delete minimal.overstay_amount;
    expect(parseCheckIn(rawCheckIn({ booking: minimal })).booking.amount).toBeNull();
  });
});
