import type { BookingStatus } from '@/features/booking/bookingSchemas';
import {
  applyObservation,
  isTerminalPhase,
  nextDelayMs,
  observationOf,
  POLL_MAX_MS,
  startPolling,
  type PollState,
} from '@/features/payment/paymentPolling';
import type { RefundStatus } from '@/features/payment/refundView';

export interface PollSource {
  status: BookingStatus;
  holdExpiresAtMs: number | null;
  refundStatus: RefundStatus;
}

export interface PollerDeps<T extends PollSource> {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** One request for the current booking; must honour `signal`. */
  load(signal: AbortSignal): Promise<T>;
  isFatal(error: unknown): boolean;
  onState(state: PollState): void;
  /** Every answer; `changed` = the status moved since the last answer, or the poll just ended. */
  onData(data: T, info: { changed: boolean }): void;
}

export interface Poller {
  /** (Re)start from zero: fresh budget, first request at once. */
  start(): void;
  /** Cancel the timer and the request in flight for good. */
  stop(): void;
  /** App went to the background: nothing runs, the state and the deadline are kept. */
  pause(): void;
  /** App is back: one request at once, then the normal cadence (no-op unless paused and unfinished). */
  resume(): void;
  getState(): PollState;
}

/**
 * The polling loop as plain code over injected clock / timers / request, so it can be tested with
 * fake timers. The decisions are `paymentPolling` (pure); this adds only scheduling, abort and
 * the stale-answer guard (`epoch`).
 */
export function createPoller<T extends PollSource>(deps: PollerDeps<T>, maxMs: number = POLL_MAX_MS): Poller {
  let state = startPolling(deps.now(), maxMs);
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let epoch = 0;
  let isPaused = false;
  let lastStatus: BookingStatus | null = null;

  const cancelWork = (): void => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    controller?.abort();
    controller = null;
    epoch += 1;
  };

  const schedule = (delay: number | null): void => {
    if (delay === null) return;
    timer = deps.setTimer(() => {
      timer = null;
      void tick();
    }, delay);
  };

  const tick = async (): Promise<void> => {
    const mine = epoch;
    const own = new AbortController();
    controller = own;
    let data: T | null = null;
    let observation;
    try {
      data = await deps.load(own.signal);
      observation = observationOf(data);
    } catch (error: unknown) {
      observation = { kind: 'error' as const, isFatal: deps.isFatal(error) };
    }
    if (mine !== epoch) return;
    controller = null;
    state = applyObservation(state, observation, deps.now());
    deps.onState(state);
    if (data !== null) {
      deps.onData(data, { changed: data.status !== lastStatus || isTerminalPhase(state.phase) });
      lastStatus = data.status;
    }
    schedule(nextDelayMs(state, deps.now()));
  };

  return {
    start() {
      cancelWork();
      isPaused = false;
      lastStatus = null;
      state = startPolling(deps.now(), maxMs);
      schedule(nextDelayMs(state, deps.now()));
    },
    stop() {
      cancelWork();
      isPaused = false;
    },
    pause() {
      if (isTerminalPhase(state.phase)) return;
      cancelWork();
      isPaused = true;
    },
    resume() {
      if (!isPaused || isTerminalPhase(state.phase)) return;
      isPaused = false;
      schedule(0);
    },
    getState: () => state,
  };
}
