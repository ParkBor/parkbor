import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookingStatus } from '@/features/booking/bookingSchemas';
import { createPoller, type PollSource } from '@/features/payment/paymentPoller';
import { MAX_CONSECUTIVE_ERRORS, type PollState } from '@/features/payment/paymentPolling';

interface Data extends PollSource {
  id: string;
}

const data = (status: BookingStatus, extra: Partial<Data> = {}): Data => ({
  id: 'x',
  status,
  holdExpiresAtMs: null,
  refundStatus: 'none',
  ...extra,
});

function setup(script: (call: number, signal: AbortSignal) => Promise<Data>, isFatal: (e: unknown) => boolean = () => false) {
  const states: PollState[] = [];
  const seen: { data: Data; changed: boolean }[] = [];
  let calls = 0;
  const signals: AbortSignal[] = [];
  const load = vi.fn((signal: AbortSignal) => {
    calls += 1;
    signals.push(signal);
    return script(calls, signal);
  });
  const poller = createPoller<Data>({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    load,
    isFatal,
    onState: (state) => states.push(state),
    onData: (value, info) => seen.push({ data: value, changed: info.changed }),
  });
  return { poller, load, states, seen, signals };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T09:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPoller: cadence', () => {
  it('asks at once, then every 2.5 s while the booking is pending', async () => {
    const { poller, load } = setup(async () => data('PENDING_PAYMENT'));
    poller.start();
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2499);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(4);
    poller.stop();
  });

  it('stops after the paid answer and reports the final state', async () => {
    const { poller, load, states } = setup(async (call) => data(call < 3 ? 'PENDING_PAYMENT' : 'CONFIRMED'));
    poller.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(states.at(-1)?.phase).toBe('paid');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up with a timeout at 75 s of a webhook that never comes', async () => {
    const { poller, load, states } = setup(async () => data('PENDING_PAYMENT'));
    poller.start();
    await vi.advanceTimersByTimeAsync(74_000);
    expect(states.at(-1)?.phase).toBe('checking');
    await vi.advanceTimersByTimeAsync(2000);
    expect(states.at(-1)?.phase).toBe('timeout');
    const calls = load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createPoller: errors', () => {
  it('five failures in a row end in failed', async () => {
    const { poller, states } = setup(async () => {
      throw new Error('network');
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(states.at(-1)?.phase).toBe('failed');
    expect(states.filter((s) => s.consecutiveErrors > 0)).toHaveLength(MAX_CONSECUTIVE_ERRORS);
  });

  it('a success in between resets the streak', async () => {
    const { poller, states } = setup(async (call) => {
      if (call % 2 === 1) throw new Error('flaky');
      return data('PENDING_PAYMENT');
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(states.at(-1)?.phase).toBe('checking');
    poller.stop();
  });

  it('a fatal error (isFatal) fails immediately', async () => {
    const { poller, states, load } = setup(
      async () => {
        throw new Error('404');
      },
      () => true,
    );
    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states.at(-1)?.phase).toBe('failed');
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('createPoller: stop / abort / cleanup', () => {
  it('stop() cancels the timer and aborts the request in flight; its late answer is ignored', async () => {
    let release: (value: Data) => void = () => undefined;
    const { poller, signals, states, seen } = setup(
      () => new Promise<Data>((resolve) => {
        release = resolve;
      }),
    );
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals[0]?.aborted).toBe(false);
    poller.stop();
    expect(signals[0]?.aborted).toBe(true);
    release(data('CONFIRMED'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states).toHaveLength(0);
    expect(seen).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop() before the first request leaves no timer behind', () => {
    const { poller, load } = setup(async () => data('PENDING_PAYMENT'));
    poller.start();
    poller.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });

  it('start() again (recheck) restarts the clock and the 75 s budget', async () => {
    const { poller, states } = setup(async () => data('PENDING_PAYMENT'));
    poller.start();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(states.at(-1)?.phase).toBe('timeout');
    poller.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(poller.getState().phase).toBe('checking');
    await vi.advanceTimersByTimeAsync(75_000);
    expect(poller.getState().phase).toBe('timeout');
  });
});

describe('createPoller: app in the background', () => {
  it('pause() silences the polling; resume() checks once at once, then continues', async () => {
    const { poller, load } = setup(async () => data('PENDING_PAYMENT'));
    poller.start();
    await vi.advanceTimersByTimeAsync(5100);
    const before = load.mock.calls.length;
    poller.pause();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load.mock.calls.length).toBe(before);
    poller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(load.mock.calls.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(load.mock.calls.length).toBe(before + 2);
    poller.stop();
  });

  it('pause() aborts a request in flight', async () => {
    const { poller, signals } = setup(() => new Promise<Data>(() => undefined));
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    poller.pause();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('resume() without a pause does nothing extra; after a finished check it does nothing at all', async () => {
    const { poller, load } = setup(async () => data('CONFIRMED'));
    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    poller.resume();
    poller.resume();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('after a long background the deadline still holds: one check, then the timeout', async () => {
    const { poller, states } = setup(async () => data('PENDING_PAYMENT'));
    poller.start();
    await vi.advanceTimersByTimeAsync(3000);
    poller.pause();
    await vi.advanceTimersByTimeAsync(120_000);
    poller.resume();
    await vi.advanceTimersByTimeAsync(100);
    expect(states.at(-1)?.phase).toBe('timeout');
  });
});

describe('createPoller: data callbacks', () => {
  it('reports every answer, flagging a change only when the status moves or the poll ends', async () => {
    const { poller, seen } = setup(async (call) => data(call < 4 ? 'PENDING_PAYMENT' : 'CONFIRMED'));
    poller.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(seen.map((entry) => entry.changed)).toEqual([true, false, false, true]);
  });

  it('a terminal answer is always flagged as a change', async () => {
    const { poller, seen } = setup(async () => data('EXPIRED'));
    poller.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(seen).toEqual([{ data: data('EXPIRED'), changed: true }]);
  });
});
