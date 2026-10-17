import { describe, expect, it } from 'vitest';

import { cardFromCheckIn, cardFromCheckOut, cardFromFailure, cardNeedsAction, lostResultCard } from '@/features/operator/gateResult';
import { rawCheckIn, rawCheckOut } from '@/features/operator/fixtures';
import type { GateFailure } from '@/features/operator/gateErrors';
import { parseCheckIn, parseCheckOut } from '@/features/operator/operatorSchemas';

describe('cardFromCheckIn', () => {
  it('green: allowed + checked_in, with the plate, slot, time and overstay rule', () => {
    const card = cardFromCheckIn(parseCheckIn(rawCheckIn()));
    expect(card).toMatchObject({ tone: 'green', glyph: '✓', titleKey: 'operator.tone.green', reasonKey: 'operator.result.checked_in' });
    expect(card.details).toMatchObject({ plate: '01A123BC', slotCode: 'A-12', zone: 'A', floor: 1, kind: 'ONLINE' });
    expect(card.details?.checkoutByMs).toBe(Date.parse('2026-10-17T11:00:00+05:00'));
  });

  it('amber: already_checked_in, allowed=false (nobody is admitted)', () => {
    const card = cardFromCheckIn(parseCheckIn(rawCheckIn({ allowed: false, result: 'already_checked_in' })));
    expect(card).toMatchObject({ tone: 'amber', glyph: '!', reasonKey: 'operator.result.already_checked_in' });
  });

  it('red for an unknown result code, and for contradictory flags', () => {
    expect(cardFromCheckIn(parseCheckIn(rawCheckIn({ result: 'new_thing' }))).tone).toBe('red');
    expect(cardFromCheckIn(parseCheckIn(rawCheckIn({ allowed: true, result: 'already_checked_in' }))).tone).toBe('red');
    expect(cardFromCheckIn(parseCheckIn(rawCheckIn({ allowed: false, result: 'checked_in' }))).tone).toBe('red');
    expect(cardFromCheckIn(parseCheckIn(rawCheckIn({ result: 'new_thing' }))).reasonKey).toBe('operator.result.unknown');
  });
});

describe('cardFromCheckOut', () => {
  it('green when completed and allowed', () => {
    const card = cardFromCheckOut(parseCheckOut(rawCheckOut({ to_collect: '0.00', overstay: { minutes: 0, amount: '0.00', status: 'none' } })));
    expect(card).toMatchObject({ tone: 'green', reasonKey: 'operator.result.completed' });
    expect(card.details).toMatchObject({ plate: '01A123BC', actualMinutes: 138, toCollect: null, overstayAmount: null });
  });

  it('shows the overstay amount and the cash to collect from the server', () => {
    const card = cardFromCheckOut(parseCheckOut(rawCheckOut()));
    expect(card.details).toMatchObject({ overstayAmount: '3000.00', toCollect: '3000.00' });
  });

  it('amber for a repeated exit QR (already_completed, allowed=false)', () => {
    const card = cardFromCheckOut(parseCheckOut(rawCheckOut({ result: 'already_completed', allowed: false, to_collect: '0.00' })));
    expect(card).toMatchObject({ tone: 'amber', reasonKey: 'operator.result.already_completed' });
  });

  it('red for an unknown result', () => {
    expect(cardFromCheckOut(parseCheckOut(rawCheckOut({ result: 'zzz' }))).tone).toBe('red');
  });

  it('outcome overrides: collected is green, deferred / still_due / needs_review are amber', () => {
    const res = parseCheckOut(rawCheckOut());
    expect(cardFromCheckOut(res, 'collected')).toMatchObject({ tone: 'green', reasonKey: 'operator.result.collected' });
    expect(cardFromCheckOut(res, 'deferred')).toMatchObject({ tone: 'amber', reasonKey: 'operator.result.deferred' });
    expect(cardFromCheckOut(res, 'still_due')).toMatchObject({ tone: 'amber', reasonKey: 'operator.result.still_due' });
    expect(cardFromCheckOut(res, 'needs_review')).toMatchObject({ tone: 'amber', reasonKey: 'operator.result.needs_review' });
  });
});

describe('cardFromFailure', () => {
  const failure: GateFailure = { reasonKey: 'operator.reason.qr_expired', code: 'qr_expired', status: 409, retry: 'none', retryAfterSec: null };

  it('red with the reason key and no details', () => {
    expect(cardFromFailure(failure)).toMatchObject({
      tone: 'red',
      glyph: '✕',
      titleKey: 'operator.tone.red',
      reasonKey: 'operator.reason.qr_expired',
      details: null,
      retry: 'none',
    });
  });

  it('carries the retry policy and the wait time', () => {
    const card = cardFromFailure({ ...failure, code: 'scan_locked', retry: 'wait', retryAfterSec: 30 });
    expect(card.retry).toBe('wait');
    expect(card.retryAfterSec).toBe(30);
  });
});

describe('unclear and lost results are amber, never red (the server may have changed)', () => {
  it('a contract failure after a 2xx is amber with the manual-check message', () => {
    const card = cardFromFailure({ reasonKey: 'operator.reason.contract', code: null, status: null, retry: 'none', retryAfterSec: null });
    expect(card).toMatchObject({ tone: 'amber', glyph: '!', titleKey: 'operator.tone.amber', reasonKey: 'operator.reason.contract', retry: 'none' });
  });

  it('lostResultCard tells the operator to check the car / scan again', () => {
    expect(lostResultCard()).toMatchObject({ tone: 'amber', reasonKey: 'operator.result.lost', details: null, retry: 'none' });
  });
});

describe('isCheckIn flag (no string matching in the view)', () => {
  it('is true for check-in cards only', () => {
    expect(cardFromCheckIn(parseCheckIn(rawCheckIn())).isCheckIn).toBe(true);
    expect(cardFromCheckIn(parseCheckIn(rawCheckIn({ allowed: false, result: 'already_checked_in' }))).isCheckIn).toBe(true);
    expect(cardFromCheckOut(parseCheckOut(rawCheckOut())).isCheckIn).toBe(false);
    expect(cardFromFailure({ reasonKey: 'operator.reason.x', code: null, status: null, retry: 'none', retryAfterSec: null }).isCheckIn).toBe(false);
  });
});

describe('cardNeedsAction (cards that must not vanish by themselves)', () => {
  const failure = (reasonKey: string, retry: 'none' | 'manual' | 'wait' | 'auto_once') => cardFromFailure({ reasonKey, code: null, status: null, retry, retryAfterSec: null });

  it('a retry button keeps the card', () => {
    expect(cardNeedsAction(failure('operator.reason.network', 'manual'))).toBe(true);
    expect(cardNeedsAction(failure('operator.reason.scan_locked', 'wait'))).toBe(true);
  });

  it('an unclear result ("check by hand") and a lost result stay until dismissed', () => {
    expect(cardNeedsAction(failure('operator.reason.contract', 'none'))).toBe(true);
    expect(cardNeedsAction(lostResultCard())).toBe(true);
  });

  it('plain verdict cards may disappear by themselves', () => {
    expect(cardNeedsAction(failure('operator.reason.qr_expired', 'none'))).toBe(false);
    expect(cardNeedsAction(cardFromCheckIn(parseCheckIn(rawCheckIn())))).toBe(false);
  });
});
