import type { GateFailure } from '@/features/operator/gateErrors';
import { cardFromCheckOut, cardFromFailure, type CheckOutOutcome, type GateCard } from '@/features/operator/gateResult';
import { isZeroMoney } from '@/features/operator/money';
import type { CheckOutResult, MapSlot } from '@/features/operator/operatorSchemas';
import { canOverrideExit, isOperatorRole } from '@/features/operator/tabVisibility';

// Two-step exit (ARCHITECTURE 10.8):
//   1) collect:false -> the server frees the slot and answers with the cash due (`to_collect`);
//   2) cash taken -> the SAME request repeats with collect:true.
// The client never computes money: every amount comes from the server response.

/** What identifies the exit. Kept in memory only for the length of the flow; never logged. */
export type CheckoutTarget =
  | { kind: 'qr'; token: string; plate?: string }
  | { kind: 'manual'; bookingId: string; plate: string; overrideNote?: string };

export type CheckoutOutcome = 'completed' | 'already_completed' | 'collected' | 'deferred' | 'still_due' | 'needs_review';

export type CheckoutState =
  | { phase: 'idle' }
  | { phase: 'requesting'; step: 'first' | 'collect'; target: CheckoutTarget; res?: CheckOutResult }
  | { phase: 'awaiting_cash'; target: CheckoutTarget; res: CheckOutResult }
  | { phase: 'done'; outcome: CheckoutOutcome; res: CheckOutResult }
  | { phase: 'error'; step: 'first' | 'collect'; target: CheckoutTarget; failure: GateFailure; res?: CheckOutResult };

export type CheckoutEvent =
  | { type: 'start'; target: CheckoutTarget }
  | { type: 'response'; res: CheckOutResult }
  | { type: 'collect' }
  | { type: 'defer' }
  /** OWNER / ADMIN settle a debt that is under review, with a written reason (override). */
  | { type: 'override'; note: string; role: string | null | undefined }
  | { type: 'failed'; failure: GateFailure }
  | { type: 'retry' }
  | { type: 'back' }
  | { type: 'reset' };

/** The written override reason must not outlive the attempt it was written for. */
function withoutNote(target: CheckoutTarget): CheckoutTarget {
  if (target.kind !== 'manual' || target.overrideNote === undefined) return target;
  return { kind: 'manual', bookingId: target.bookingId, plate: target.plate };
}

export const IDLE: CheckoutState = { phase: 'idle' };

/** The "Pul olindi" button is available only when the server has not flagged the debt for review. */
export function canCollect(state: CheckoutState): boolean {
  return state.phase === 'awaiting_cash' && !state.res.overstay.needsReview;
}

function afterFirst(target: CheckoutTarget, res: CheckOutResult): CheckoutState {
  if (!isZeroMoney(res.toCollect)) return { phase: 'awaiting_cash', target, res };
  return { phase: 'done', outcome: res.result === 'completed' ? 'completed' : 'already_completed', res };
}

function afterCollect(res: CheckOutResult): CheckoutState {
  return { phase: 'done', outcome: isZeroMoney(res.toCollect) ? 'collected' : 'still_due', res };
}

/**
 * Pure state machine. A transition that is not allowed returns the SAME state object, so a caller
 * can detect it (`next === state`) and must not send a request: that is the double-press guard.
 */
export function checkoutReducer(state: CheckoutState, event: CheckoutEvent): CheckoutState {
  switch (event.type) {
    case 'start':
      return state.phase === 'idle' ? { phase: 'requesting', step: 'first', target: event.target } : state;
    case 'response':
      if (state.phase !== 'requesting') return state;
      return state.step === 'first' ? afterFirst(state.target, event.res) : afterCollect(event.res);
    case 'collect':
      return canCollect(state) && state.phase === 'awaiting_cash'
        ? { phase: 'requesting', step: 'collect', target: state.target, res: state.res }
        : state;
    case 'defer':
      if (state.phase !== 'awaiting_cash') return state;
      return { phase: 'done', outcome: state.res.overstay.needsReview ? 'needs_review' : 'deferred', res: state.res };
    case 'override': {
      if (state.phase !== 'awaiting_cash' || !state.res.overstay.needsReview || !canOverrideExit(event.role)) return state;
      const note = event.note.trim();
      if (note.length === 0 || note.length > MAX_OVERRIDE_NOTE) return state;
      // The debt is settled through the manual path: booking id + plate + override + note.
      const target: CheckoutTarget = { kind: 'manual', bookingId: state.res.booking.id, plate: state.res.booking.plate, overrideNote: note };
      return { phase: 'requesting', step: 'collect', target, res: state.res };
    }
    case 'failed':
      if (state.phase !== 'requesting') return state;
      // The server says the charge is under review (409 needs_review): back to the cash step with
      // the cash button off. Nothing was collected.
      if (state.step === 'collect' && state.res && event.failure.code === 'needs_review') {
        return { phase: 'awaiting_cash', target: state.target, res: { ...state.res, overstay: { ...state.res.overstay, needsReview: true } } };
      }
      return { phase: 'error', step: state.step, target: state.target, failure: event.failure, ...(state.res ? { res: state.res } : {}) };
    case 'retry':
      if (state.phase !== 'error' || state.failure.retry === 'none') return state;
      return { phase: 'requesting', step: state.step, target: state.target, ...(state.res ? { res: state.res } : {}) };
    case 'back':
      return state.phase === 'error' && state.step === 'collect' && state.res
        ? { phase: 'awaiting_cash', target: withoutNote(state.target), res: state.res }
        : state;
    case 'reset':
      return IDLE;
  }
}

const CARD_OUTCOME: Partial<Record<CheckoutOutcome, CheckOutOutcome>> = {
  collected: 'collected',
  deferred: 'deferred',
  still_due: 'still_due',
  needs_review: 'needs_review',
};

/**
 * The result card of a finished exit (or of a failed FIRST request). While cash is pending, or a
 * collect request runs / failed, there is no card: the cash panel is on screen instead.
 */
export function checkoutCard(state: CheckoutState): GateCard | null {
  if (state.phase === 'error' && state.step === 'first') return cardFromFailure(state.failure);
  if (state.phase !== 'done') return null;
  return cardFromCheckOut(state.res, CARD_OUTCOME[state.outcome]);
}

/** Cash step on screen: waiting for the money, collecting, or a failed collect. */
export function isCashStep(state: CheckoutState): boolean {
  return (
    state.phase === 'awaiting_cash' ||
    (state.phase === 'requesting' && state.step === 'collect') ||
    (state.phase === 'error' && state.step === 'collect')
  );
}

// --- manual exit (no QR) ------------------------------------------------------------------------

export interface ManualExitCandidate {
  bookingId: string;
  plate: string;
  slotCode: string;
  zone: string;
  floor: number;
  sinceMs: number;
  /** ONLINE car: only OWNER / ADMIN may release it without the exit QR, with a written reason. */
  needsOverride: boolean;
}

/**
 * Cars inside that can be released by hand. WALK_IN: any staff role. ONLINE: only OWNER / ADMIN
 * (override + note); an operator releases ONLINE cars with the driver's exit QR only. A car whose
 * plate the server did not send is skipped - the plate is the confirmation of the manual exit.
 */
export function manualExitCandidates(slots: readonly MapSlot[], role: string | null | undefined): ManualExitCandidate[] {
  if (!isOperatorRole(role) && !canOverrideExit(role)) return [];
  const result: ManualExitCandidate[] = [];
  for (const slot of slots) {
    const booking = slot.current;
    if (booking === null || booking.plate === null) continue;
    if (booking.status !== 'ACTIVE' && booking.status !== 'OVERSTAY') continue;
    const needsOverride = booking.kind !== 'WALK_IN';
    if (needsOverride && !canOverrideExit(role)) continue;
    result.push({
      bookingId: booking.id,
      plate: booking.plate,
      slotCode: slot.code,
      zone: slot.zone,
      floor: slot.floor,
      sinceMs: booking.startMs,
      needsOverride,
    });
  }
  return result;
}

export const MAX_OVERRIDE_NOTE = 200;

export type NoteCheck = { ok: true; note: string } | { ok: false; reason: 'empty' | 'too_long' };

/** The override reason is mandatory, at most 200 characters. It is stored in the audit trail. */
export function validateOverrideNote(raw: string): NoteCheck {
  const note = raw.trim();
  if (note.length === 0) return { ok: false, reason: 'empty' };
  if (note.length > MAX_OVERRIDE_NOTE) return { ok: false, reason: 'too_long' };
  return { ok: true, note };
}
