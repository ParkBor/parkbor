import { backoffDelay, IMMEDIATE_RECONNECT_MS } from '@/features/realtime/backoff';
import { classifyClose } from '@/features/realtime/closePolicy';

// Pure connection lifecycle: (state, event) -> (state, effects). The shell (realtimeClient.ts)
// performs the effects and feeds results back as events, so every reconnect rule is testable
// without a socket, a timer or a clock.

export type Phase = 'off' | 'ticketing' | 'connecting' | 'open' | 'backoff' | 'refreshing' | 'stopped';
export type StopReason = 'fatal' | 'replaced' | 'rate_limited' | 'auth';
/** What the UI cares about: `live` = events flow, so polling can relax. */
export type RealtimeStatus = 'off' | 'connecting' | 'live' | 'waiting' | 'stopped';

/** Close 4429 asks for at least 30 s of calm. */
export const RATE_LIMIT_COOLDOWN_MS = 30_000;
/** A connection must stay ready this long before failures stop escalating the backoff. */
export const STABLE_AFTER_MS = 30_000;
/** `online` may shortcut a backoff only after it has run this long. */
export const ONLINE_RETRY_MIN_MS = 5000;
/** More than MAX_IMMEDIATE immediate reconnects within the window fall back to normal backoff. */
export const MAX_IMMEDIATE = 3;
export const IMMEDIATE_WINDOW_MS = 60_000;
/** The shortcut is not for escalated waits. */
const ONLINE_SHORTCUT_MAX_ATTEMPT = 3;

export interface LifecycleState {
  phase: Phase;
  /** Signed-in user (null = no session: nothing to connect). */
  userKey: string | null;
  isForeground: boolean;
  /** Failed attempts since the connection last stayed up for STABLE_AFTER_MS. */
  attempt: number;
  /** A 4401 already triggered one token refresh since the last `ready`. */
  hasRefreshed: boolean;
  stopReason: StopReason | null;
  stoppedAtMs: number | null;
  /** When the current connection became ready (null = not ready). */
  readyAtMs: number | null;
  /** When the current backoff wait began, and whether a 429 caused it. */
  backoffStartedMs: number | null;
  isRateLimitBackoff: boolean;
  /** Recent 4410-style immediate reconnects (to stop a loop). */
  immediateAtMs: number[];
}

export const INITIAL_STATE: LifecycleState = {
  phase: 'off',
  userKey: null,
  isForeground: true,
  attempt: 0,
  hasRefreshed: false,
  stopReason: null,
  stoppedAtMs: null,
  readyAtMs: null,
  backoffStartedMs: null,
  isRateLimitBackoff: false,
  immediateAtMs: [],
};

export type TicketFailure = 'auth' | 'rate_limited' | 'other';

export type LifecycleEvent =
  | { type: 'session'; userKey: string | null }
  | { type: 'foreground'; isForeground: boolean }
  | { type: 'online' }
  | { type: 'ticket_ok'; ticket: string }
  | { type: 'ticket_failed'; failure: TicketFailure; retryAfterMs?: number }
  | { type: 'ready' }
  | { type: 'closed'; code: number | undefined }
  | { type: 'refreshed'; ok: boolean }
  | { type: 'timer' };

export type Effect =
  /** Close any socket, cancel timers, and ignore results of work still in flight. */
  | { type: 'abort' }
  | { type: 'fetch_ticket' }
  | { type: 'open_socket'; ticket: string }
  | { type: 'schedule'; ms: number }
  | { type: 'refresh_token' }
  /** Send `subscribe` for every group the screens currently want. */
  | { type: 'sync_groups' };

export interface TransitionContext {
  nowMs: number;
  /** 0..1, for jitter. */
  random: number;
}

export interface Transition {
  state: LifecycleState;
  effects: Effect[];
}

const none = (state: LifecycleState): Transition => ({ state, effects: [] });

function wantsConnection(state: LifecycleState): boolean {
  return state.userKey !== null && state.isForeground && state.stopReason === null;
}

/** Starts a connection cycle if one is wanted and none is running. */
function connectIfWanted(state: LifecycleState, prefix: Effect[] = []): Transition {
  if (state.phase !== 'off' || !wantsConnection(state)) return { state, effects: prefix };
  return { state: { ...state, phase: 'ticketing' }, effects: [...prefix, { type: 'fetch_ticket' }] };
}

function stop(state: LifecycleState, reason: StopReason, nowMs: number, effects: Effect[]): Transition {
  return { state: { ...state, phase: 'stopped', stopReason: reason, stoppedAtMs: nowMs }, effects };
}

function backoff(state: LifecycleState, ms: number, nextAttempt: number, nowMs: number, isRateLimit = false): Transition {
  return {
    state: { ...state, phase: 'backoff', attempt: nextAttempt, readyAtMs: null, backoffStartedMs: nowMs, isRateLimitBackoff: isRateLimit },
    effects: [{ type: 'abort' }, { type: 'schedule', ms }],
  };
}

/** A stop that does not outlive the app going to the background and coming back. */
function releaseStop(state: LifecycleState, nowMs: number): LifecycleState {
  const { stopReason, stoppedAtMs } = state;
  const isReleased =
    stopReason === 'replaced' ||
    (stopReason === 'rate_limited' && stoppedAtMs !== null && nowMs - stoppedAtMs >= RATE_LIMIT_COOLDOWN_MS);
  return isReleased ? { ...state, phase: 'off', stopReason: null, stoppedAtMs: null } : state;
}

function onSession(state: LifecycleState, userKey: string | null): Transition {
  if (state.userKey === userKey) return none(state);
  const fresh: LifecycleState = { ...INITIAL_STATE, userKey, isForeground: state.isForeground };
  return connectIfWanted(fresh, [{ type: 'abort' }]);
}

function onForeground(state: LifecycleState, isForeground: boolean, nowMs: number): Transition {
  const next = { ...state, isForeground };
  if (!isForeground) {
    if (next.phase === 'off' || next.phase === 'stopped') return none(next);
    return { state: { ...next, phase: 'off', attempt: 0, hasRefreshed: false }, effects: [{ type: 'abort' }] };
  }
  return connectIfWanted(releaseStop(next, nowMs));
}

function onTicketFailed(state: LifecycleState, event: Extract<LifecycleEvent, { type: 'ticket_failed' }>, ctx: TransitionContext): Transition {
  if (state.phase !== 'ticketing') return none(state);
  // 401/403 on the ticket endpoint: the session is over (HTTP already tried to refresh).
  if (event.failure === 'auth') return stop(state, 'auth', ctx.nowMs, []);
  const wait = Math.max(backoffDelay(state.attempt, ctx.random), event.retryAfterMs ?? 0);
  return backoff(state, wait, state.attempt + 1, ctx.nowMs, event.failure === 'rate_limited');
}

function onClosed(state: LifecycleState, code: number | undefined, ctx: TransitionContext): Transition {
  if (state.phase !== 'connecting' && state.phase !== 'open') return none(state);
  const abort: Effect[] = [{ type: 'abort' }];
  // A connection that stayed up long enough was healthy: its failures start the backoff over.
  const wasStable = state.readyAtMs !== null && ctx.nowMs - state.readyAtMs >= STABLE_AFTER_MS;
  const attempt = wasStable ? 0 : state.attempt;
  switch (classifyClose(code)) {
    case 'fatal':
      return stop(state, 'fatal', ctx.nowMs, abort);
    case 'replaced':
      return stop(state, 'replaced', ctx.nowMs, abort);
    case 'rate_limited':
      return stop(state, 'rate_limited', ctx.nowMs, abort);
    case 'auth':
      if (state.hasRefreshed) return stop(state, 'auth', ctx.nowMs, abort);
      return { state: { ...state, phase: 'refreshing', hasRefreshed: true }, effects: [...abort, { type: 'refresh_token' }] };
    case 'immediate': {
      const recent = [...state.immediateAtMs.filter((t) => ctx.nowMs - t < IMMEDIATE_WINDOW_MS), ctx.nowMs];
      const next = { ...state, immediateAtMs: recent };
      if (recent.length > MAX_IMMEDIATE) return backoff(next, backoffDelay(attempt, ctx.random), attempt + 1, ctx.nowMs);
      return backoff(next, IMMEDIATE_RECONNECT_MS, attempt, ctx.nowMs);
    }
    case 'backoff':
      return backoff(state, backoffDelay(attempt, ctx.random), attempt + 1, ctx.nowMs);
  }
}

export function transition(state: LifecycleState, event: LifecycleEvent, ctx: TransitionContext): Transition {
  switch (event.type) {
    case 'session':
      return onSession(state, event.userKey);
    case 'foreground':
      return onForeground(state, event.isForeground, ctx.nowMs);
    case 'online':
      if (state.phase !== 'backoff' || !wantsConnection(state)) return none(state);
      // Never bypass a 429 Retry-After, an escalated wait, or hammer the endpoint.
      if (state.isRateLimitBackoff || state.attempt > ONLINE_SHORTCUT_MAX_ATTEMPT) return none(state);
      if (state.backoffStartedMs !== null && ctx.nowMs - state.backoffStartedMs < ONLINE_RETRY_MIN_MS) return none(state);
      return { state: { ...state, phase: 'ticketing' }, effects: [{ type: 'abort' }, { type: 'fetch_ticket' }] };
    case 'timer':
      if (state.phase !== 'backoff' || !wantsConnection(state)) return none(state);
      return { state: { ...state, phase: 'ticketing' }, effects: [{ type: 'fetch_ticket' }] };
    case 'ticket_ok':
      if (state.phase !== 'ticketing') return none(state);
      return { state: { ...state, phase: 'connecting' }, effects: [{ type: 'open_socket', ticket: event.ticket }] };
    case 'ticket_failed':
      return onTicketFailed(state, event, ctx);
    case 'ready':
      if (state.phase !== 'connecting') return none(state);
      return {
        state: { ...state, phase: 'open', hasRefreshed: false, readyAtMs: ctx.nowMs },
        effects: [{ type: 'sync_groups' }],
      };
    case 'closed':
      return onClosed(state, event.code, ctx);
    case 'refreshed':
      if (state.phase !== 'refreshing') return none(state);
      if (!event.ok) return stop(state, 'auth', ctx.nowMs, []);
      return { state: { ...state, phase: 'ticketing' }, effects: [{ type: 'fetch_ticket' }] };
  }
}

export function statusOf(state: LifecycleState): RealtimeStatus {
  switch (state.phase) {
    case 'open':
      return 'live';
    case 'ticketing':
    case 'connecting':
    case 'refreshing':
      return 'connecting';
    case 'backoff':
      return 'waiting';
    case 'stopped':
      return 'stopped';
    case 'off':
      return 'off';
  }
}
