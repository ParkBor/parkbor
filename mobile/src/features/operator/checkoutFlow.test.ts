import { describe, expect, it } from 'vitest';

import {
  canCollect,
  checkoutCard,
  isCashStep,
  checkoutReducer,
  IDLE,
  manualExitCandidates,
  validateOverrideNote,
  type CheckoutState,
  type CheckoutTarget,
} from '@/features/operator/checkoutFlow';
import { rawCheckOut, rawMapBooking, rawMapSlot, rawSlotMap } from '@/features/operator/fixtures';
import type { GateFailure } from '@/features/operator/gateErrors';
import { parseCheckOut, parseSlotMap } from '@/features/operator/operatorSchemas';

const TARGET: CheckoutTarget = { kind: 'qr', token: 'x'.repeat(30) };
const due = parseCheckOut(rawCheckOut());
const free = parseCheckOut(rawCheckOut({ to_collect: '0.00', overstay: { minutes: 0, amount: '0.00', status: 'none' } }));
const failure: GateFailure = { reasonKey: 'operator.reason.network', code: null, status: null, retry: 'manual', retryAfterSec: null };

function started(): CheckoutState {
  return checkoutReducer(IDLE, { type: 'start', target: TARGET });
}

describe('checkoutReducer: first request', () => {
  it('start moves idle -> requesting(first) and remembers the target', () => {
    const s = started();
    expect(s).toEqual({ phase: 'requesting', step: 'first', target: TARGET });
    expect(s.phase).toBe('requesting');
  });

  it('start is ignored while a request is already running (double scan)', () => {
    const s = started();
    expect(checkoutReducer(s, { type: 'start', target: { kind: 'qr', token: 'y'.repeat(30) } })).toBe(s);
  });

  it('to_collect = 0 finishes at once', () => {
    const s = checkoutReducer(started(), { type: 'response', res: free });
    expect(s).toMatchObject({ phase: 'done', outcome: 'completed' });
  });

  it('to_collect = 0 on a repeated exit QR finishes as already_completed (amber)', () => {
    const repeat = parseCheckOut(rawCheckOut({ result: 'already_completed', allowed: false, to_collect: '0.00' }));
    expect(checkoutReducer(started(), { type: 'response', res: repeat })).toMatchObject({ phase: 'done', outcome: 'already_completed' });
  });

  it('to_collect > 0 waits for the cash; the amount is the server value', () => {
    const s = checkoutReducer(started(), { type: 'response', res: due });
    expect(s).toMatchObject({ phase: 'awaiting_cash', target: TARGET });
    expect(s.phase === 'awaiting_cash' && s.res.toCollect).toBe('3000.00');
    expect(canCollect(s)).toBe(true);
  });

  it('a repeated exit QR that still owes money also waits for the cash', () => {
    const repeat = parseCheckOut(rawCheckOut({ result: 'already_completed', allowed: false }));
    expect(checkoutReducer(started(), { type: 'response', res: repeat }).phase).toBe('awaiting_cash');
  });

  it('a response nobody asked for is ignored', () => {
    expect(checkoutReducer(IDLE, { type: 'response', res: due })).toBe(IDLE);
  });
});

describe('checkoutReducer: collect', () => {
  const awaiting = checkoutReducer(started(), { type: 'response', res: due });

  it('"Pul olindi" repeats the same request with collect', () => {
    const s = checkoutReducer(awaiting, { type: 'collect' });
    expect(s).toMatchObject({ phase: 'requesting', step: 'collect', target: TARGET });
  });

  it('a second press while collecting is a no-op (same state object)', () => {
    const collecting = checkoutReducer(awaiting, { type: 'collect' });
    expect(checkoutReducer(collecting, { type: 'collect' })).toBe(collecting);
  });

  it('collect outside awaiting_cash is ignored', () => {
    expect(checkoutReducer(IDLE, { type: 'collect' })).toBe(IDLE);
    expect(checkoutReducer(started(), { type: 'collect' })).toEqual(started());
  });

  it('collected when the server reports nothing left to collect', () => {
    const s = checkoutReducer(checkoutReducer(awaiting, { type: 'collect' }), {
      type: 'response',
      res: parseCheckOut(rawCheckOut({ result: 'already_completed', allowed: false, to_collect: '0.00', overstay: { minutes: 20, amount: '3000.00', status: 'collected' } })),
    });
    expect(s).toMatchObject({ phase: 'done', outcome: 'collected' });
  });

  it('still_due when the server still reports money after collect (capped / under review)', () => {
    const s = checkoutReducer(checkoutReducer(awaiting, { type: 'collect' }), { type: 'response', res: due });
    expect(s).toMatchObject({ phase: 'done', outcome: 'still_due' });
  });

  it('defer ("Keyinroq") ends with the debt left on the server', () => {
    expect(checkoutReducer(awaiting, { type: 'defer' })).toMatchObject({ phase: 'done', outcome: 'deferred' });
    expect(checkoutReducer(IDLE, { type: 'defer' })).toBe(IDLE);
  });
});

describe('checkoutReducer: needs_review (cap / manual decision)', () => {
  const review = parseCheckOut(rawCheckOut({ overstay: { minutes: 99999, amount: '999999.00', status: 'due', needs_review: true }, to_collect: '999999.00' }));
  const s = checkoutReducer(started(), { type: 'response', res: review });

  it('the cash button is disabled; the operator can only acknowledge', () => {
    expect(s.phase).toBe('awaiting_cash');
    expect(canCollect(s)).toBe(false);
    expect(checkoutReducer(s, { type: 'collect' })).toBe(s);
    expect(checkoutReducer(s, { type: 'defer' })).toMatchObject({ phase: 'done', outcome: 'needs_review' });
  });
});

describe('checkoutReducer: needs_review refusal at collect time', () => {
  const needsReviewFailure: GateFailure = { reasonKey: 'operator.reason.needs_review', code: 'needs_review', status: 409, retry: 'none', retryAfterSec: null };
  const awaiting = checkoutReducer(started(), { type: 'response', res: due });

  it('a 409 needs_review on collect returns to the cash step with the cash button OFF', () => {
    const collecting = checkoutReducer(awaiting, { type: 'collect' });
    const s = checkoutReducer(collecting, { type: 'failed', failure: needsReviewFailure });
    expect(s.phase).toBe('awaiting_cash');
    expect(canCollect(s)).toBe(false);
    expect(s.phase === 'awaiting_cash' && s.res.overstay.needsReview).toBe(true);
    expect(s.phase === 'awaiting_cash' && s.res.toCollect).toBe('3000.00');
  });

  it('on the first request the same code is a normal error', () => {
    expect(checkoutReducer(started(), { type: 'failed', failure: needsReviewFailure }).phase).toBe('error');
  });
});

describe('checkoutReducer: override of a debt under review', () => {
  const review = parseCheckOut(rawCheckOut({ overstay: { minutes: 9, amount: '9.00', status: 'due', needs_review: true }, to_collect: '9.00' }));
  const inReview = checkoutReducer(started(), { type: 'response', res: review });

  it('OWNER / ADMIN settle it with booking id + plate + a written note, as a collect step', () => {
    for (const role of ['OWNER', 'ADMIN']) {
      const s = checkoutReducer(inReview, { type: 'override', note: 'kassir tasdiqladi', role });
      expect(s).toMatchObject({
        phase: 'requesting',
        step: 'collect',
        target: { kind: 'manual', bookingId: review.booking.id, plate: '01A123BC', overrideNote: 'kassir tasdiqladi' },
      });
    }
  });

  it('an OPERATOR (or unknown role) cannot: same state object', () => {
    expect(checkoutReducer(inReview, { type: 'override', note: 'x', role: 'OPERATOR' })).toBe(inReview);
    expect(checkoutReducer(inReview, { type: 'override', note: 'x', role: undefined })).toBe(inReview);
  });

  it('only from a debt that is under review, and only with a non-blank note', () => {
    const plain = checkoutReducer(started(), { type: 'response', res: due });
    expect(checkoutReducer(plain, { type: 'override', note: 'x', role: 'OWNER' })).toBe(plain);
    expect(checkoutReducer(IDLE, { type: 'override', note: 'x', role: 'OWNER' })).toBe(IDLE);
    expect(checkoutReducer(inReview, { type: 'override', note: '   ', role: 'OWNER' })).toBe(inReview);
  });

  it('after the override the usual collect outcomes apply', () => {
    const requesting = checkoutReducer(inReview, { type: 'override', note: 'ok', role: 'OWNER' });
    const repeat = parseCheckOut(rawCheckOut({ result: 'already_completed', allowed: false, to_collect: '0.00' }));
    expect(checkoutReducer(requesting, { type: 'response', res: repeat })).toMatchObject({ phase: 'done', outcome: 'collected' });
    const failed = checkoutReducer(requesting, { type: 'failed', failure });
    expect(checkoutReducer(failed, { type: 'back' })).toMatchObject({ phase: 'awaiting_cash' });
  });
});

describe('checkoutReducer: Back after a failed override', () => {
  const review = parseCheckOut(rawCheckOut({ overstay: { minutes: 9, amount: '9.00', status: 'due', needs_review: true }, to_collect: '9.00' }));

  it('does not keep the written note in the target', () => {
    const inReview = checkoutReducer(started(), { type: 'response', res: review });
    const requesting = checkoutReducer(inReview, { type: 'override', note: 'private reason', role: 'OWNER' });
    const failed = checkoutReducer(requesting, { type: 'failed', failure });
    const back = checkoutReducer(failed, { type: 'back' });
    expect(back.phase).toBe('awaiting_cash');
    expect(JSON.stringify(back)).not.toContain('private reason');
  });

  it('a QR target is kept as it is', () => {
    const awaiting = checkoutReducer(started(), { type: 'response', res: due });
    const failed = checkoutReducer(checkoutReducer(awaiting, { type: 'collect' }), { type: 'failed', failure });
    expect(checkoutReducer(failed, { type: 'back' })).toMatchObject({ phase: 'awaiting_cash', target: TARGET });
  });
});

describe('checkoutReducer: failures', () => {
  it('a failed first request can be retried', () => {
    const failed = checkoutReducer(started(), { type: 'failed', failure });
    expect(failed).toMatchObject({ phase: 'error', step: 'first', failure });
    expect(checkoutReducer(failed, { type: 'retry' })).toMatchObject({ phase: 'requesting', step: 'first', target: TARGET });
  });

  it('a failed collect keeps the amount and retries the collect step', () => {
    const awaiting = checkoutReducer(started(), { type: 'response', res: due });
    const failed = checkoutReducer(checkoutReducer(awaiting, { type: 'collect' }), { type: 'failed', failure });
    expect(failed).toMatchObject({ phase: 'error', step: 'collect' });
    expect(checkoutReducer(failed, { type: 'retry' })).toMatchObject({ phase: 'requesting', step: 'collect' });
    expect(checkoutReducer(failed, { type: 'back' })).toMatchObject({ phase: 'awaiting_cash' });
  });

  it('retry is refused when the failure cannot be repeated', () => {
    const failed = checkoutReducer(started(), { type: 'failed', failure: { ...failure, retry: 'none' } });
    expect(checkoutReducer(failed, { type: 'retry' })).toBe(failed);
  });

  it('failed outside a request is ignored; reset always returns to idle', () => {
    expect(checkoutReducer(IDLE, { type: 'failed', failure })).toBe(IDLE);
    expect(checkoutReducer(started(), { type: 'reset' })).toBe(IDLE);
  });

  it('back outside a collect error is ignored', () => {
    expect(checkoutReducer(IDLE, { type: 'back' })).toBe(IDLE);
  });
});

describe('manualExitCandidates', () => {
  const map = parseSlotMap(
    rawSlotMap([
      rawMapSlot({ code: 'A-1', status: 'OCCUPIED', current_booking: rawMapBooking({ kind: 'WALK_IN' }) }),
      rawMapSlot({ id: '99999999-2222-4333-8444-555555555555', code: 'A-2', status: 'OCCUPIED', current_booking: rawMapBooking({ kind: 'ONLINE', plate_number: '10B777CC' }) }),
      rawMapSlot({ id: '88888888-2222-4333-8444-555555555555', code: 'A-3', status: 'FREE' }),
      rawMapSlot({ id: '77777777-2222-4333-8444-555555555555', code: 'A-4', status: 'OCCUPIED', current_booking: rawMapBooking({ kind: 'WALK_IN', plate_number: null }) }),
    ]),
  );

  it('an operator sees walk-ins only (ONLINE cars leave with the exit QR)', () => {
    const list = manualExitCandidates(map.slots, 'OPERATOR');
    expect(list.map((c) => c.slotCode)).toEqual(['A-1']);
    expect(list[0]).toMatchObject({ plate: '01A123BC', needsOverride: false });
  });

  it('OWNER / ADMIN also see ONLINE cars, flagged as override', () => {
    for (const role of ['OWNER', 'ADMIN']) {
      const list = manualExitCandidates(map.slots, role);
      expect(list.map((c) => [c.slotCode, c.needsOverride])).toEqual([['A-1', false], ['A-2', true]]);
    }
  });

  it('skips entries without a plate (the plate is the second factor) and unknown roles', () => {
    expect(manualExitCandidates(map.slots, 'OPERATOR').some((c) => c.slotCode === 'A-4')).toBe(false);
    expect(manualExitCandidates(map.slots, 'DRIVER')).toEqual([]);
  });
});

describe('validateOverrideNote', () => {
  it('requires a non-blank reason of at most 200 characters', () => {
    expect(validateOverrideNote('  telefon o‘lgan ')).toEqual({ ok: true, note: 'telefon o‘lgan' });
    expect(validateOverrideNote('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(validateOverrideNote('x'.repeat(201))).toEqual({ ok: false, reason: 'too_long' });
    expect(validateOverrideNote('x'.repeat(200))).toMatchObject({ ok: true });
  });
});

describe('checkoutCard / isCashStep', () => {
  const awaiting = checkoutReducer(started(), { type: 'response', res: due });

  it('no card while idle, requesting, or waiting for the cash', () => {
    expect(checkoutCard(IDLE)).toBeNull();
    expect(checkoutCard(started())).toBeNull();
    expect(checkoutCard(awaiting)).toBeNull();
  });

  it('green card for a finished exit, amber for a repeated one', () => {
    expect(checkoutCard(checkoutReducer(started(), { type: 'response', res: free }))).toMatchObject({ tone: 'green' });
    const repeat = parseCheckOut(rawCheckOut({ result: 'already_completed', allowed: false, to_collect: '0.00' }));
    expect(checkoutCard(checkoutReducer(started(), { type: 'response', res: repeat }))).toMatchObject({ tone: 'amber' });
  });

  it('outcome cards: collected green; deferred / needs_review amber', () => {
    const collected = checkoutReducer(checkoutReducer(awaiting, { type: 'collect' }), {
      type: 'response',
      res: parseCheckOut(rawCheckOut({ result: 'already_completed', allowed: false, to_collect: '0.00' })),
    });
    expect(checkoutCard(collected)).toMatchObject({ tone: 'green', reasonKey: 'operator.result.collected' });
    expect(checkoutCard(checkoutReducer(awaiting, { type: 'defer' }))).toMatchObject({ tone: 'amber', reasonKey: 'operator.result.deferred' });
  });

  it('a failed first request is a red card; a failed collect stays in the cash step', () => {
    expect(checkoutCard(checkoutReducer(started(), { type: 'failed', failure }))).toMatchObject({ tone: 'red' });
    const failedCollect = checkoutReducer(checkoutReducer(awaiting, { type: 'collect' }), { type: 'failed', failure });
    expect(checkoutCard(failedCollect)).toBeNull();
    expect(isCashStep(failedCollect)).toBe(true);
  });

  it('isCashStep is true only around the money', () => {
    expect(isCashStep(IDLE)).toBe(false);
    expect(isCashStep(started())).toBe(false);
    expect(isCashStep(awaiting)).toBe(true);
    expect(isCashStep(checkoutReducer(awaiting, { type: 'collect' }))).toBe(true);
    expect(isCashStep(checkoutReducer(awaiting, { type: 'defer' }))).toBe(false);
  });
});
