import type { GateFailure, RetryPolicy } from '@/features/operator/gateErrors';
import type { BookingKind, CheckInResult, CheckOutResult } from '@/features/operator/operatorSchemas';
import { isZeroMoney } from '@/features/operator/money';

export type Tone = 'green' | 'amber' | 'red';

/** Glyphs make the tone readable without colour (colour-blind operators, sun glare). */
const GLYPH: Record<Tone, string> = { green: '✓', amber: '!', red: '✕' };

export interface GateDetails {
  plate: string;
  slotCode: string;
  zone: string;
  floor: number;
  kind: BookingKind;
  startMs: number | null;
  endMs: number | null;
  /** Check-in only: when the car must leave to avoid an extra charge. */
  checkoutByMs: number | null;
  /** Check-out only. */
  actualMinutes: number | null;
  /** Server decimal string; null when there is nothing to show (zero). */
  overstayAmount: string | null;
  toCollect: string | null;
}

export interface GateCard {
  tone: Tone;
  glyph: string;
  titleKey: string;
  reasonKey: string;
  details: GateDetails | null;
  /** The card describes a check-in (the plate must be compared with the car). */
  isCheckIn: boolean;
  retry: RetryPolicy;
  retryAfterSec: number | null;
}

export type CheckOutOutcome = 'collected' | 'deferred' | 'still_due' | 'needs_review';

const OUTCOME_CARD: Record<CheckOutOutcome, { tone: Tone; reason: string }> = {
  collected: { tone: 'green', reason: 'collected' },
  deferred: { tone: 'amber', reason: 'deferred' },
  still_due: { tone: 'amber', reason: 'still_due' },
  needs_review: { tone: 'amber', reason: 'needs_review' },
};

function card(tone: Tone, reason: string, details: GateDetails | null, isCheckIn = false): GateCard {
  return {
    tone,
    glyph: GLYPH[tone],
    titleKey: `operator.tone.${tone}`,
    reasonKey: `operator.result.${reason}`,
    details,
    isCheckIn,
    retry: 'none',
    retryAfterSec: null,
  };
}

function nonZero(amount: string): string | null {
  return isZeroMoney(amount) ? null : amount;
}

function baseDetails(booking: CheckInResult['booking']): Omit<GateDetails, 'checkoutByMs' | 'actualMinutes' | 'overstayAmount' | 'toCollect'> {
  return {
    plate: booking.plate,
    slotCode: booking.slot.code,
    zone: booking.slot.zone,
    floor: booking.slot.floor,
    kind: booking.kind,
    startMs: booking.startMs,
    endMs: booking.endMs,
  };
}

/** Green only for `allowed: true` + `checked_in`; amber only for `allowed: false` + `already_checked_in`. */
export function cardFromCheckIn(result: CheckInResult): GateCard {
  const details: GateDetails = {
    ...baseDetails(result.booking),
    checkoutByMs: result.checkoutByMs,
    actualMinutes: null,
    overstayAmount: null,
    toCollect: null,
  };
  if (result.allowed && result.result === 'checked_in') return card('green', 'checked_in', details, true);
  if (!result.allowed && result.result === 'already_checked_in') return card('amber', 'already_checked_in', details, true);
  return card('red', 'unknown', null);
}

/** `outcome` (from the two-step flow) overrides the plain server result. */
export function cardFromCheckOut(result: CheckOutResult, outcome?: CheckOutOutcome): GateCard {
  const details: GateDetails = {
    ...baseDetails(result.booking),
    checkoutByMs: null,
    actualMinutes: result.actualMinutes,
    overstayAmount: nonZero(result.overstay.amount),
    toCollect: nonZero(result.toCollect),
  };
  if (outcome !== undefined) {
    const { tone, reason } = OUTCOME_CARD[outcome];
    return card(tone, reason, details);
  }
  if (result.allowed && result.result === 'completed') return card('green', 'completed', details);
  if (!result.allowed && result.result === 'already_completed') return card('amber', 'already_completed', details);
  return card('red', 'unknown', null);
}

/** A reason that means "the request went through but the answer could not be read": see cardFromFailure. */
const UNCLEAR_REASON = 'operator.reason.contract';

/**
 * Red for a refusal. A 2xx whose body this version cannot read is AMBER instead: the server may
 * already have admitted / released the car, so "refused" would be a lie ("check by hand").
 */
export function cardFromFailure(failure: GateFailure): GateCard {
  const tone: Tone = failure.reasonKey === UNCLEAR_REASON ? 'amber' : 'red';
  return {
    tone,
    glyph: GLYPH[tone],
    titleKey: `operator.tone.${tone}`,
    reasonKey: failure.reasonKey,
    details: null,
    isCheckIn: false,
    retry: failure.retry,
    retryAfterSec: failure.retryAfterSec,
  };
}

/**
 * Cards that must stay until the operator dismisses them: a retry button is on them, or the result
 * is unclear / not shown (the operator has to look at the car) - vanishing would hide exactly that.
 */
export function cardNeedsAction(card: GateCard): boolean {
  return card.retry !== 'none' || card.reasonKey === UNCLEAR_REASON || card.reasonKey === 'operator.result.lost';
}

/** The screen was left while a request ran; the server did answer, the answer was not shown. */
export function lostResultCard(): GateCard {
  return card('amber', 'lost', null);
}
