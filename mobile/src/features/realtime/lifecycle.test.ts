import { describe, expect, it } from 'vitest';

import {
  IMMEDIATE_WINDOW_MS,
  INITIAL_STATE,
  MAX_IMMEDIATE,
  ONLINE_RETRY_MIN_MS,
  RATE_LIMIT_COOLDOWN_MS,
  STABLE_AFTER_MS,
  statusOf,
  transition,
  type Effect,
  type LifecycleEvent,
  type LifecycleState,
} from '@/features/realtime/lifecycle';

const T0 = 1_000_000;
const MID = 0.5; // jitter-free random

function step(state: LifecycleState, event: LifecycleEvent, nowMs = T0) {
  return transition(state, event, { nowMs, random: MID });
}

/** Runs events in order, returning the final state and every effect emitted. */
function run(events: LifecycleEvent[], from: LifecycleState = INITIAL_STATE, nowMs = T0) {
  let state = from;
  const effects: Effect[] = [];
  for (const event of events) {
    const result = step(state, event, nowMs);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

const login: LifecycleEvent = { type: 'session', userKey: 'u1' };
const open: LifecycleEvent[] = [login, { type: 'ticket_ok', ticket: 'T1' }, { type: 'ready' }];
const kinds = (effects: Effect[]) => effects.map((e) => e.type);

describe('connecting', () => {
  it('does nothing without a session', () => {
    expect(step(INITIAL_STATE, { type: 'foreground', isForeground: true })).toEqual({ state: INITIAL_STATE, effects: [] });
  });

  it('fetches a ticket as soon as there is a session in the foreground', () => {
    const { state, effects } = step(INITIAL_STATE, login);
    expect(state.phase).toBe('ticketing');
    expect(kinds(effects)).toEqual(['abort', 'fetch_ticket']);
  });

  it('opens the socket with the ticket it was given, then goes live on ready', () => {
    const { state, effects } = run(open);
    expect(state.phase).toBe('open');
    expect(effects).toContainEqual({ type: 'open_socket', ticket: 'T1' });
    expect(effects.at(-1)).toEqual({ type: 'sync_groups' });
    expect(statusOf(state)).toBe('live');
  });

  it('does not connect in the background; connects when the app returns', () => {
    const bg = step({ ...INITIAL_STATE, isForeground: false }, login);
    expect(bg.state.phase).toBe('off');
    expect(kinds(bg.effects)).not.toContain('fetch_ticket');
    const fg = step(bg.state, { type: 'foreground', isForeground: true });
    expect(fg.state.phase).toBe('ticketing');
    expect(kinds(fg.effects)).toContain('fetch_ticket');
  });

  it('ignores a ticket that arrives when nobody waits for it', () => {
    expect(step(INITIAL_STATE, { type: 'ticket_ok', ticket: 'late' })).toEqual({ state: INITIAL_STATE, effects: [] });
    const live = run(open).state;
    expect(step(live, { type: 'ticket_ok', ticket: 'late' }).effects).toEqual([]);
  });

  it('a repeated session event for the same user changes nothing', () => {
    const live = run(open).state;
    expect(step(live, login)).toEqual({ state: live, effects: [] });
  });
});

describe('session end and account switch', () => {
  it('logout aborts everything and resets', () => {
    const { state, effects } = step(run(open).state, { type: 'session', userKey: null });
    expect(state).toEqual({ ...INITIAL_STATE });
    expect(kinds(effects)).toEqual(['abort']);
  });

  it('switching accounts drops the old connection and takes a ticket for the new one', () => {
    const { state, effects } = step(run(open).state, { type: 'session', userKey: 'u2' });
    expect(state.userKey).toBe('u2');
    expect(state.phase).toBe('ticketing');
    expect(kinds(effects)).toEqual(['abort', 'fetch_ticket']);
  });

  it('a logout clears a stop (fatal) so the next login can connect', () => {
    const stopped = run([...open, { type: 'closed', code: 4400 }]).state;
    expect(stopped.phase).toBe('stopped');
    const next = run([{ type: 'session', userKey: null }, login], stopped).state;
    expect(next.phase).toBe('ticketing');
  });
});

describe('background / foreground', () => {
  it('closes the connection in the background and forgets the attempt counter', () => {
    const failing = run([login, { type: 'ticket_failed', failure: 'other' }]).state;
    expect(failing.attempt).toBe(1);
    const { state, effects } = step(failing, { type: 'foreground', isForeground: false });
    expect(state.phase).toBe('off');
    expect(state.attempt).toBe(0);
    expect(kinds(effects)).toEqual(['abort']);
  });

  it('reconnects with a NEW ticket when the app returns', () => {
    const bg = step(run(open).state, { type: 'foreground', isForeground: false }).state;
    const { state, effects } = step(bg, { type: 'foreground', isForeground: true });
    expect(state.phase).toBe('ticketing');
    expect(kinds(effects)).toEqual(['fetch_ticket']);
  });

  it('a redundant foreground event while live is a no-op', () => {
    const live = run(open).state;
    expect(step(live, { type: 'foreground', isForeground: true })).toEqual({ state: live, effects: [] });
  });

  it('keeps a fatal stop across background / foreground', () => {
    const fatal = run([...open, { type: 'closed', code: 1009 }]).state;
    const again = run([{ type: 'foreground', isForeground: false }, { type: 'foreground', isForeground: true }], fatal).state;
    expect(again.phase).toBe('stopped');
    expect(again.stopReason).toBe('fatal');
  });
});

describe('ticket failures', () => {
  it('backs off exponentially with jitter, counting attempts', () => {
    const first = run([login, { type: 'ticket_failed', failure: 'other' }]);
    expect(first.state.phase).toBe('backoff');
    expect(first.effects.at(-1)).toEqual({ type: 'schedule', ms: 1000 });
    const second = run([{ type: 'timer' }, { type: 'ticket_failed', failure: 'other' }], first.state);
    expect(second.effects.at(-1)).toEqual({ type: 'schedule', ms: 2000 });
  });

  it('a timer in backoff fetches a new ticket', () => {
    const waiting = run([login, { type: 'ticket_failed', failure: 'other' }]).state;
    const { state, effects } = step(waiting, { type: 'timer' });
    expect(state.phase).toBe('ticketing');
    expect(kinds(effects)).toEqual(['fetch_ticket']);
  });

  it('waits at least Retry-After on 429', () => {
    const { effects } = run([login, { type: 'ticket_failed', failure: 'rate_limited', retryAfterMs: 20_000 }]);
    expect(effects.at(-1)).toEqual({ type: 'schedule', ms: 20_000 });
  });

  it('takes the longer of backoff and Retry-After', () => {
    const { effects } = run([login, { type: 'ticket_failed', failure: 'rate_limited', retryAfterMs: 10 }]);
    expect(effects.at(-1)).toEqual({ type: 'schedule', ms: 1000 });
  });

  it('stops for good when the ticket endpoint refuses the account (401/403)', () => {
    const { state, effects } = run([login, { type: 'ticket_failed', failure: 'auth' }]);
    expect(state.phase).toBe('stopped');
    expect(state.stopReason).toBe('auth');
    expect(kinds(effects)).not.toContain('schedule');
    expect(statusOf(state)).toBe('stopped');
  });

  it('ignores a failure nobody waits for', () => {
    expect(step(INITIAL_STATE, { type: 'ticket_failed', failure: 'other' })).toEqual({ state: INITIAL_STATE, effects: [] });
  });

  it('coming back online skips the wait (after the minimum interval)', () => {
    const waiting = run([login, { type: 'ticket_failed', failure: 'other' }]).state;
    const { state, effects } = step(waiting, { type: 'online' }, T0 + ONLINE_RETRY_MIN_MS);
    expect(state.phase).toBe('ticketing');
    expect(kinds(effects)).toEqual(['abort', 'fetch_ticket']);
    expect(state.attempt).toBe(1);
  });

  it('online right after a failure does not hammer the ticket endpoint', () => {
    const waiting = run([login, { type: 'ticket_failed', failure: 'other' }]).state;
    expect(step(waiting, { type: 'online' }, T0 + ONLINE_RETRY_MIN_MS - 1)).toEqual({ state: waiting, effects: [] });
  });

  it('online never bypasses a 429 Retry-After', () => {
    const waiting = run([login, { type: 'ticket_failed', failure: 'rate_limited', retryAfterMs: 60_000 }]).state;
    expect(step(waiting, { type: 'online' }, T0 + 10 * 60_000).effects).toEqual([]);
    // ... and an ordinary failure afterwards is shortcut-able again
    const other = run([{ type: 'timer' }, { type: 'ticket_failed', failure: 'other' }], waiting, T0 + 70_000).state;
    expect(step(other, { type: 'online' }, T0 + 80_000).state.phase).toBe('ticketing');
  });

  it('online does not shortcut an escalated backoff', () => {
    let state = run([login, { type: 'ticket_failed', failure: 'other' }]).state;
    for (let i = 0; i < 4; i += 1) state = run([{ type: 'timer' }, { type: 'ticket_failed', failure: 'other' }], state).state;
    expect(state.attempt).toBeGreaterThan(3);
    expect(step(state, { type: 'online' }, T0 + 60_000).effects).toEqual([]);
  });

  it('online while live or off does nothing', () => {
    const live = run(open).state;
    expect(step(live, { type: 'online' }).effects).toEqual([]);
    expect(step(INITIAL_STATE, { type: 'online' }).effects).toEqual([]);
  });
});

describe('close codes after ready', () => {
  const live = () => run(open).state;

  it.each([4408, 1011, 1013, 1006])('code %i reconnects with backoff', (code) => {
    const { state, effects } = step(live(), { type: 'closed', code });
    expect(state.phase).toBe('backoff');
    expect(effects.at(-1)).toEqual({ type: 'schedule', ms: 1000 });
  });

  it('a connection that stayed up STABLE_AFTER_MS starts the backoff over', () => {
    const afterFailures = run([
      login,
      { type: 'ticket_failed', failure: 'other' },
      { type: 'timer' },
      { type: 'ticket_failed', failure: 'other' },
      { type: 'timer' },
      { type: 'ticket_ok', ticket: 'T' },
      { type: 'ready' },
    ]).state;
    expect(afterFailures.attempt).toBe(2);
    expect(step(afterFailures, { type: 'closed', code: 1006 }, T0 + STABLE_AFTER_MS).effects.at(-1)).toEqual({ type: 'schedule', ms: 1000 });
  });

  it('a flapping connection (ready, then dropped within seconds) keeps escalating', () => {
    const afterFailures = run([
      login,
      { type: 'ticket_failed', failure: 'other' },
      { type: 'timer' },
      { type: 'ticket_failed', failure: 'other' },
      { type: 'timer' },
      { type: 'ticket_ok', ticket: 'T' },
      { type: 'ready' },
    ]).state;
    const closed = step(afterFailures, { type: 'closed', code: 1006 }, T0 + STABLE_AFTER_MS - 1);
    expect(closed.effects.at(-1)).toEqual({ type: 'schedule', ms: 4000 });
    expect(closed.state.attempt).toBe(3);
  });

  it('a close before ready keeps counting attempts', () => {
    const connecting = run([login, { type: 'ticket_ok', ticket: 'T' }]).state;
    const closed = step(connecting, { type: 'closed', code: 1006 });
    expect(closed.state.attempt).toBe(1);
    const second = run([{ type: 'timer' }, { type: 'ticket_ok', ticket: 'T2' }, { type: 'closed', code: 1006 }], closed.state);
    expect(second.effects.at(-1)).toEqual({ type: 'schedule', ms: 2000 });
  });

  it('4410 (max age) reconnects almost at once and keeps the counter at zero', () => {
    const { state, effects } = step(live(), { type: 'closed', code: 4410 });
    expect(state.phase).toBe('backoff');
    expect(state.attempt).toBe(0);
    expect(effects.at(-1)).toEqual({ type: 'schedule', ms: 250 });
  });

  it('repeated immediate closes (a 4410 loop) fall back to normal backoff', () => {
    let state = live();
    const delays: number[] = [];
    for (let i = 0; i <= MAX_IMMEDIATE; i += 1) {
      const closed = step(state, { type: 'closed', code: 4410 }, T0 + i * 1000);
      const schedule = closed.effects.at(-1);
      delays.push(schedule?.type === 'schedule' ? schedule.ms : -1);
      state = run([{ type: 'timer' }, { type: 'ticket_ok', ticket: 'T' }, { type: 'ready' }], closed.state, T0 + i * 1000).state;
    }
    expect(delays.slice(0, MAX_IMMEDIATE)).toEqual([250, 250, 250]);
    expect(delays[MAX_IMMEDIATE]).toBeGreaterThanOrEqual(700);
  });

  it('immediate closes spread over more than the window stay immediate', () => {
    let state = live();
    for (let i = 0; i < 6; i += 1) {
      const at = T0 + i * (IMMEDIATE_WINDOW_MS + 1);
      const closed = step(state, { type: 'closed', code: 4410 }, at);
      expect(closed.effects.at(-1)).toEqual({ type: 'schedule', ms: 250 });
      state = run([{ type: 'timer' }, { type: 'ticket_ok', ticket: 'T' }, { type: 'ready' }], closed.state, at).state;
    }
  });

  it.each([
    [4400, 'fatal'],
    [1009, 'fatal'],
    [4409, 'replaced'],
    [4429, 'rate_limited'],
  ])('code %i stops (%s) and never schedules a reconnect', (code, reason) => {
    const { state, effects } = step(live(), { type: 'closed', code });
    expect(state.phase).toBe('stopped');
    expect(state.stopReason).toBe(reason);
    expect(kinds(effects)).toEqual(['abort']);
  });

  it('ignores a close that arrives when no socket is expected', () => {
    expect(step(INITIAL_STATE, { type: 'closed', code: 1006 })).toEqual({ state: INITIAL_STATE, effects: [] });
    const bg = step(live(), { type: 'foreground', isForeground: false }).state;
    expect(step(bg, { type: 'closed', code: 1006 })).toEqual({ state: bg, effects: [] });
  });
});

describe('4401: refresh the token once, then take a new ticket', () => {
  it('refreshes, then re-tickets', () => {
    const closed = step(run(open).state, { type: 'closed', code: 4401 });
    expect(closed.state.phase).toBe('refreshing');
    expect(kinds(closed.effects)).toEqual(['abort', 'refresh_token']);
    const refreshed = step(closed.state, { type: 'refreshed', ok: true });
    expect(refreshed.state.phase).toBe('ticketing');
    expect(kinds(refreshed.effects)).toEqual(['fetch_ticket']);
  });

  it('a failed refresh stops the connection (the HTTP layer ends the session)', () => {
    const closed = step(run(open).state, { type: 'closed', code: 4401 }).state;
    const { state } = step(closed, { type: 'refreshed', ok: false });
    expect(state.phase).toBe('stopped');
    expect(state.stopReason).toBe('auth');
  });

  it('a second 4401 without a successful ready in between does not refresh again', () => {
    const afterRefresh = run([...open, { type: 'closed', code: 4401 }, { type: 'refreshed', ok: true }, { type: 'ticket_ok', ticket: 'T2' }]).state;
    const second = step(afterRefresh, { type: 'closed', code: 4401 });
    expect(second.state.phase).toBe('stopped');
    expect(second.state.stopReason).toBe('auth');
    expect(kinds(second.effects)).not.toContain('refresh_token');
  });

  it('the refresh budget is renewed by a successful ready', () => {
    const renewed = run([...open, { type: 'closed', code: 4401 }, { type: 'refreshed', ok: true }, { type: 'ticket_ok', ticket: 'T2' }, { type: 'ready' }]).state;
    expect(step(renewed, { type: 'closed', code: 4401 }).state.phase).toBe('refreshing');
  });

  it('ignores a refresh result nobody waits for', () => {
    expect(step(INITIAL_STATE, { type: 'refreshed', ok: true })).toEqual({ state: INITIAL_STATE, effects: [] });
  });
});

describe('stop codes and the foreground', () => {
  it('4409: the next foreground (a new user-driven session of the app) reconnects', () => {
    const replaced = run([...open, { type: 'closed', code: 4409 }]).state;
    const bg = step(replaced, { type: 'foreground', isForeground: false }).state;
    const { state, effects } = step(bg, { type: 'foreground', isForeground: true });
    expect(state.phase).toBe('ticketing');
    expect(kinds(effects)).toContain('fetch_ticket');
  });

  it('4429: stays down until the cooldown has passed', () => {
    const limited = run([...open, { type: 'closed', code: 4429 }], INITIAL_STATE, T0).state;
    expect(limited.stoppedAtMs).toBe(T0);
    const early = step(limited, { type: 'foreground', isForeground: true }, T0 + RATE_LIMIT_COOLDOWN_MS - 1);
    expect(early.state.phase).toBe('stopped');
    expect(early.effects).toEqual([]);
    const later = step(limited, { type: 'foreground', isForeground: true }, T0 + RATE_LIMIT_COOLDOWN_MS);
    expect(later.state.phase).toBe('ticketing');
  });

  it('a stopped connection ignores timers and online events', () => {
    const fatal = run([...open, { type: 'closed', code: 4400 }]).state;
    expect(step(fatal, { type: 'timer' }).effects).toEqual([]);
    expect(step(fatal, { type: 'online' }).effects).toEqual([]);
  });
});

describe('statusOf', () => {
  it('maps phases to what the UI needs', () => {
    expect(statusOf(INITIAL_STATE)).toBe('off');
    expect(statusOf({ ...INITIAL_STATE, phase: 'ticketing' })).toBe('connecting');
    expect(statusOf({ ...INITIAL_STATE, phase: 'connecting' })).toBe('connecting');
    expect(statusOf({ ...INITIAL_STATE, phase: 'refreshing' })).toBe('connecting');
    expect(statusOf({ ...INITIAL_STATE, phase: 'backoff' })).toBe('waiting');
    expect(statusOf({ ...INITIAL_STATE, phase: 'open' })).toBe('live');
    expect(statusOf({ ...INITIAL_STATE, phase: 'stopped' })).toBe('stopped');
  });
});
