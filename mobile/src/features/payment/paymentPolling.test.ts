import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import type { BookingStatus } from '@/features/booking/bookingSchemas';
import { ContractError } from '@/lib/contract';
import {
  applyObservation,
  holdHasLapsed,
  isFatalPollError,
  isTerminalPhase,
  MAX_CONSECUTIVE_ERRORS,
  nextDelayMs,
  observationOf,
  POLL_INTERVAL_MS,
  POLL_MAX_MS,
  startPolling,
  type PollObservation,
  type PollState,
} from '@/features/payment/paymentPolling';

const T0 = 1_000_000;

const booking = (status: BookingStatus, extra: Partial<Extract<PollObservation, { kind: 'booking' }>> = {}): PollObservation => ({
  kind: 'booking',
  status,
  holdExpiresAtMs: null,
  refundStatus: 'none',
  ...extra,
});
const error = (isFatal = false): PollObservation => ({ kind: 'error', isFatal });

describe('startPolling', () => {
  it('starts in the checking phase with nothing known', () => {
    const state = startPolling(T0);
    expect(state.phase).toBe('checking');
    expect(state.attempts).toBe(0);
    expect(state.status).toBeNull();
    expect(state.refundStatus).toBe('none');
    expect(state.holdExpiresAtMs).toBeNull();
    expect(state.deadlineMs - T0).toBe(75_000);
  });

  it('first check is immediate', () => {
    expect(nextDelayMs(startPolling(T0), T0)).toBe(0);
  });
});

describe('applyObservation: terminal statuses', () => {
  it.each<BookingStatus>(['CONFIRMED', 'ACTIVE', 'OVERSTAY', 'COMPLETED'])('%s means the payment went through', (status) => {
    expect(applyObservation(startPolling(T0), booking(status), T0 + 1000).phase).toBe('paid');
  });

  it.each<BookingStatus>(['CANCELLED', 'EXPIRED', 'NO_SHOW'])('%s means the payment was not accepted', (status) => {
    expect(applyObservation(startPolling(T0), booking(status), T0 + 1000).phase).toBe('rejected');
  });

  it('PENDING_PAYMENT keeps checking (webhook not here yet)', () => {
    const state = applyObservation(startPolling(T0), booking('PENDING_PAYMENT'), T0 + 1000);
    expect(state.phase).toBe('checking');
    expect(state.attempts).toBe(1);
    expect(state.status).toBe('PENDING_PAYMENT');
  });

  it('an unknown status keeps checking until the deadline (never assumed paid)', () => {
    const state = applyObservation(startPolling(T0), booking('unknown'), T0 + 1000);
    expect(state.phase).toBe('checking');
  });

  it('terminal phases are final: later observations change nothing', () => {
    const paid = applyObservation(startPolling(T0), booking('CONFIRMED'), T0 + 1000);
    expect(applyObservation(paid, booking('CANCELLED'), T0 + 2000)).toBe(paid);
    expect(applyObservation(paid, error(true), T0 + 2000)).toBe(paid);
    expect(nextDelayMs(paid, T0 + 2000)).toBeNull();
  });
});

describe('applyObservation: timeout', () => {
  it('still pending at the deadline -> timeout', () => {
    let state: PollState = startPolling(T0);
    state = applyObservation(state, booking('PENDING_PAYMENT'), T0 + POLL_MAX_MS - 1);
    expect(state.phase).toBe('checking');
    state = applyObservation(state, booking('PENDING_PAYMENT'), T0 + POLL_MAX_MS);
    expect(state.phase).toBe('timeout');
    expect(isTerminalPhase(state.phase)).toBe(true);
  });

  it('a paid answer exactly at the deadline wins over the timeout', () => {
    expect(applyObservation(startPolling(T0), booking('CONFIRMED'), T0 + POLL_MAX_MS).phase).toBe('paid');
  });

  it('network errors up to the deadline end in a timeout, not a hard failure', () => {
    let state = startPolling(T0);
    state = applyObservation(state, error(), T0 + POLL_MAX_MS);
    expect(state.phase).toBe('timeout');
  });
});

describe('applyObservation: errors', () => {
  it('a transient error keeps checking and counts', () => {
    const state = applyObservation(startPolling(T0), error(), T0 + 1000);
    expect(state.phase).toBe('checking');
    expect(state.consecutiveErrors).toBe(1);
  });

  it('a good answer resets the error streak', () => {
    let state = applyObservation(startPolling(T0), error(), T0 + 1000);
    state = applyObservation(state, booking('PENDING_PAYMENT'), T0 + 4000);
    expect(state.consecutiveErrors).toBe(0);
  });

  it('too many errors in a row -> failed', () => {
    let state = startPolling(T0);
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS; i += 1) state = applyObservation(state, error(), T0 + 1000 * (i + 1));
    expect(state.phase).toBe('failed');
  });

  it('a fatal error (e.g. 404 / 403) fails at once', () => {
    expect(applyObservation(startPolling(T0), error(true), T0 + 1000).phase).toBe('failed');
  });
});

describe('applyObservation: hold and refund updates', () => {
  it('follows the extended hold reported by the server', () => {
    let state = applyObservation(startPolling(T0), booking('PENDING_PAYMENT', { holdExpiresAtMs: T0 + 60_000 }), T0 + 1000);
    expect(state.holdExpiresAtMs).toBe(T0 + 60_000);
    state = applyObservation(state, booking('PENDING_PAYMENT', { holdExpiresAtMs: T0 + 300_000 }), T0 + 4000);
    expect(state.holdExpiresAtMs).toBe(T0 + 300_000);
  });

  it('records the refund status of a rejected booking', () => {
    const state = applyObservation(startPolling(T0), booking('EXPIRED', { refundStatus: 'pending' }), T0 + 1000);
    expect(state.phase).toBe('rejected');
    expect(state.refundStatus).toBe('pending');
  });

  it('does not mutate the previous state', () => {
    const initial = startPolling(T0);
    const snapshot = { ...initial };
    applyObservation(initial, booking('CONFIRMED'), T0 + 1000);
    expect(initial).toEqual(snapshot);
  });
});

describe('holdHasLapsed', () => {
  it('is true once the server hold is in the past while still pending', () => {
    const state = applyObservation(startPolling(T0), booking('PENDING_PAYMENT', { holdExpiresAtMs: T0 + 5000 }), T0 + 1000);
    expect(holdHasLapsed(state, T0 + 4999)).toBe(false);
    expect(holdHasLapsed(state, T0 + 5000)).toBe(true);
  });

  it('is false when the hold is unknown or the booking is no longer pending', () => {
    expect(holdHasLapsed(startPolling(T0), T0 + 99_999_999)).toBe(false);
    const paid = applyObservation(startPolling(T0), booking('CONFIRMED', { holdExpiresAtMs: T0 }), T0 + 1000);
    expect(holdHasLapsed(paid, T0 + 99_999)).toBe(false);
  });
});

describe('nextDelayMs', () => {
  it('waits the poll interval between good answers', () => {
    const state = applyObservation(startPolling(T0), booking('PENDING_PAYMENT'), T0 + 500);
    expect(nextDelayMs(state, T0 + 500)).toBe(2500);
  });

  it('backs off after errors but stays bounded', () => {
    let state = startPolling(T0);
    const delays: number[] = [];
    for (let i = 0; i < MAX_CONSECUTIVE_ERRORS - 1; i += 1) {
      state = applyObservation(state, error(), T0 + 100 * (i + 1));
      delays.push(nextDelayMs(state, T0 + 100 * (i + 1)) ?? -1);
    }
    expect(delays[0]).toBeGreaterThanOrEqual(POLL_INTERVAL_MS);
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] ?? 0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(10_000);
  });

  it('never waits beyond the deadline: one last check is made at it', () => {
    const state = applyObservation(startPolling(T0), booking('PENDING_PAYMENT'), T0 + POLL_MAX_MS - 500);
    expect(nextDelayMs(state, T0 + POLL_MAX_MS - 500)).toBe(500);
    expect(nextDelayMs(state, T0 + POLL_MAX_MS + 5000)).toBe(0);
  });

  it('is null once finished', () => {
    const failed = applyObservation(startPolling(T0), error(true), T0 + 1);
    expect(nextDelayMs(failed, T0 + 2)).toBeNull();
  });
});

describe('a full webhook-delay scenario', () => {
  it('pending, pending, pending, then CONFIRMED', () => {
    let state = startPolling(T0);
    let now = T0;
    const answers: BookingStatus[] = ['PENDING_PAYMENT', 'PENDING_PAYMENT', 'PENDING_PAYMENT', 'CONFIRMED'];
    for (const status of answers) {
      const delay = nextDelayMs(state, now);
      expect(delay).not.toBeNull();
      now += delay ?? 0;
      state = applyObservation(state, booking(status), now);
    }
    expect(state.phase).toBe('paid');
    expect(state.attempts).toBe(4);
  });

  it('a webhook that never arrives ends in a timeout within the maximum time', () => {
    let state = startPolling(T0);
    let now = T0;
    let guard = 0;
    while (!isTerminalPhase(state.phase) && guard < 200) {
      now += nextDelayMs(state, now) ?? 0;
      state = applyObservation(state, booking('PENDING_PAYMENT'), now);
      guard += 1;
    }
    expect(state.phase).toBe('timeout');
    expect(now - T0).toBeLessThanOrEqual(POLL_MAX_MS);
    expect(guard).toBeLessThan(200);
  });
});

const httpError = (status: number): AxiosError =>
  new AxiosError('x', 'ERR_BAD_RESPONSE', undefined, undefined, { status, data: {}, headers: {}, statusText: '', config: {} } as unknown as AxiosResponse);

describe('observationOf', () => {
  it('keeps only what the poller needs from a booking', () => {
    expect(observationOf({ status: 'CONFIRMED', holdExpiresAtMs: 5, refundStatus: 'none', paymentUrl: 'https://x', id: 'secret' } as never)).toEqual({
      kind: 'booking',
      status: 'CONFIRMED',
      holdExpiresAtMs: 5,
      refundStatus: 'none',
    });
  });
});

describe('isFatalPollError', () => {
  it('404 / 403 / a broken contract will not heal by retrying', () => {
    expect(isFatalPollError(httpError(404))).toBe(true);
    expect(isFatalPollError(httpError(403))).toBe(true);
    expect(isFatalPollError(new ContractError('booking'))).toBe(true);
  });

  it('network trouble, 5xx and throttling are transient', () => {
    expect(isFatalPollError(new AxiosError('x', 'ERR_NETWORK'))).toBe(false);
    expect(isFatalPollError(httpError(503))).toBe(false);
    expect(isFatalPollError(httpError(429))).toBe(false);
    expect(isFatalPollError(new Error('boom'))).toBe(false);
  });
});
