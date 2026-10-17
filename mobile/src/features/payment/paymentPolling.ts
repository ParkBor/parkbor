import type { BookingStatus } from '@/features/booking/bookingSchemas';
import type { RefundStatus } from '@/features/payment/refundView';
import { ContractError } from '@/lib/contract';
import { parseApiError } from '@/lib/errors';

/** Re-check the booking every 2.5 s. */
export const POLL_INTERVAL_MS = 2500;
/** Give up waiting for the webhook after 75 s. */
export const POLL_MAX_MS = 75_000;
/** This many failed requests in a row end the check (the screen then offers "check the bookings list"). */
export const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_BACKOFF_MS = 10_000;

/**
 * - `checking`  asking the server;
 * - `paid`      the server says the booking is paid (CONFIRMED or later) - the ONLY success;
 * - `rejected`  CANCELLED / EXPIRED / NO_SHOW: the payment was not accepted for this booking;
 * - `timeout`   still PENDING_PAYMENT after the maximum time (webhook late): ask the user to check later;
 * - `failed`    the booking cannot be read (not found / forbidden / repeated errors).
 */
export type PollPhase = 'checking' | 'paid' | 'rejected' | 'timeout' | 'failed';

export type PollObservation =
  | { kind: 'booking'; status: BookingStatus; holdExpiresAtMs: number | null; refundStatus: RefundStatus }
  | { kind: 'error'; isFatal: boolean };

export interface PollState {
  readonly phase: PollPhase;
  readonly attempts: number;
  readonly consecutiveErrors: number;
  readonly status: BookingStatus | null;
  /** Latest hold end the server reported (it is extended when the provider transaction starts). */
  readonly holdExpiresAtMs: number | null;
  readonly refundStatus: RefundStatus;
  readonly deadlineMs: number;
}

const PAID: ReadonlySet<BookingStatus> = new Set(['CONFIRMED', 'ACTIVE', 'OVERSTAY', 'COMPLETED']);
const REJECTED: ReadonlySet<BookingStatus> = new Set(['CANCELLED', 'EXPIRED', 'NO_SHOW']);

export function startPolling(nowMs: number, maxMs: number = POLL_MAX_MS): PollState {
  return {
    phase: 'checking',
    attempts: 0,
    consecutiveErrors: 0,
    status: null,
    holdExpiresAtMs: null,
    refundStatus: 'none',
    deadlineMs: nowMs + maxMs,
  };
}

export function isTerminalPhase(phase: PollPhase): boolean {
  return phase !== 'checking';
}

/** Pure transition: one server answer (or failure) in, the next state out. Terminal states are final. */
export function applyObservation(state: PollState, observation: PollObservation, nowMs: number): PollState {
  if (isTerminalPhase(state.phase)) return state;
  const isPastDeadline = nowMs >= state.deadlineMs;

  if (observation.kind === 'error') {
    const consecutiveErrors = state.consecutiveErrors + 1;
    let phase: PollPhase = 'checking';
    if (observation.isFatal || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) phase = 'failed';
    else if (isPastDeadline) phase = 'timeout';
    return { ...state, phase, consecutiveErrors };
  }

  const known = {
    attempts: state.attempts + 1,
    consecutiveErrors: 0,
    status: observation.status,
    holdExpiresAtMs: observation.holdExpiresAtMs,
    refundStatus: observation.refundStatus,
  };
  if (PAID.has(observation.status)) return { ...state, ...known, phase: 'paid' };
  if (REJECTED.has(observation.status)) return { ...state, ...known, phase: 'rejected' };
  return { ...state, ...known, phase: isPastDeadline ? 'timeout' : 'checking' };
}

/** Delay before the next request; 0 = ask now; null = finished. Errors back off (bounded); never past the deadline. */
export function nextDelayMs(state: PollState, nowMs: number): number | null {
  if (isTerminalPhase(state.phase)) return null;
  if (state.attempts === 0 && state.consecutiveErrors === 0) return 0;
  const backoff = Math.min(POLL_INTERVAL_MS * 2 ** Math.min(state.consecutiveErrors, 4), MAX_BACKOFF_MS);
  return Math.max(0, Math.min(backoff, state.deadlineMs - nowMs));
}

/** The server hold passed but the booking is still PENDING_PAYMENT (the sweeper has not run yet). */
export function holdHasLapsed(state: PollState, nowMs: number): boolean {
  return state.status === 'PENDING_PAYMENT' && state.holdExpiresAtMs !== null && nowMs >= state.holdExpiresAtMs;
}

export function observationOf(booking: {
  status: BookingStatus;
  holdExpiresAtMs: number | null;
  refundStatus: RefundStatus;
}): PollObservation {
  return {
    kind: 'booking',
    status: booking.status,
    holdExpiresAtMs: booking.holdExpiresAtMs,
    refundStatus: booking.refundStatus,
  };
}

/** Errors that retrying cannot fix: the booking is not ours / gone, or the server broke the contract. */
export function isFatalPollError(error: unknown): boolean {
  if (error instanceof ContractError) return true;
  const { status } = parseApiError(error);
  return status === 404 || status === 403;
}
