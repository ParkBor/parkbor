import { createFrameLimiter } from '@/features/realtime/frameLimiter';
import {
  INITIAL_STATE,
  statusOf,
  transition,
  type Effect,
  type LifecycleEvent,
  type LifecycleState,
  type RealtimeStatus,
} from '@/features/realtime/lifecycle';
import {
  MAX_GROUPS,
  PONG_MESSAGE,
  groupKey,
  normalizeGroup,
  parseServerMessage,
  planGroupMessages,
  type Group,
  type RejectedGroup,
  type ServerMessage,
} from '@/features/realtime/protocol';
import { createTokenBucket } from '@/features/realtime/rateLimit';
import { rejectAction } from '@/features/realtime/rejectPolicy';
import { createStaleFilter } from '@/features/realtime/staleFilter';
import { classifyTicketError, socketUrl } from '@/features/realtime/ticket';

/** A socket that never opened (RN gives no timeout of its own). */
export const CONNECT_TIMEOUT_MS = 15_000;
/** The server pings every 30 s; nothing for this long means the link is dead (half-open). */
export const IDLE_TIMEOUT_MS = 75_000;
/** Inbound traffic re-arms the idle watchdog at most this often. */
const REARM_MIN_GAP_MS = 1000;
const MIN_DRAIN_WAIT_MS = 50;
const NORMAL_CLOSURE = 1000;

export interface SocketLike {
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: (() => void) | null;
}

export interface ClientDeps {
  /** `extra.wsUrl`, e.g. wss://api.parkbor.uz/ws */
  wsUrl: string;
  /** A NEW one-time ticket (rejects with a TicketError). */
  fetchTicket: () => Promise<string>;
  openSocket: (url: string) => SocketLike;
  /** Refreshes the access token; false when the session is over. */
  refreshAccess: () => Promise<boolean>;
  now: () => number;
  random: () => number;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export type RealtimeEvent =
  | { type: 'availability'; lotId: string; freeSlots: number; totalSlots: number; ts: string }
  | { type: 'slot_status'; lotId: string; slotId: string; status: string }
  | { type: 'booking_status'; bookingId: string; status: string }
  | { type: 'subscribed'; groups: Group[]; rejected: RejectedGroup[] }
  | { type: 'unsubscribed'; groups: Group[] }
  | { type: 'error'; code: string }
  /** Connected again after a gap: events may have been missed, so consumers should refetch. */
  | { type: 'resync' };

export interface RealtimeClient {
  /** Wants these groups for as long as the returned release function has not been called. */
  subscribe: (groups: readonly { kind: string; id: string }[]) => () => void;
  setSession: (userKey: string | null) => void;
  setForeground: (isForeground: boolean) => void;
  notifyOnline: () => void;
  onEvent: (listener: (event: RealtimeEvent) => void) => () => void;
  /** `subscribe` signature of useSyncExternalStore. */
  onStatus: (listener: () => void) => () => void;
  getStatus: () => RealtimeStatus;
}

interface Wanted {
  group: Group;
  count: number;
}

export function createRealtimeClient(deps: ClientDeps): RealtimeClient {
  let state: LifecycleState = INITIAL_STATE;
  let lastStatus: RealtimeStatus = statusOf(state);
  let cycle = 0;
  let socket: SocketLike | null = null;
  let retryTimer: unknown = null;
  let watchdog: unknown = null;
  let watchdogArmedAt = 0;
  let drainTimer: unknown = null;
  let readyCount = 0;
  let isDispatching = false;
  let isDrainQueued = false;
  let isPongPending = false;

  const pending: LifecycleEvent[] = [];
  const wanted = new Map<string, Wanted>();
  /** Groups the server holds for this connection, recorded when the frame was actually sent. */
  const sent = new Map<string, Group>();
  /** Groups not to (re)subscribe on this connection: rejected, waiting for their one retry. */
  const blocked = new Set<string>();
  const rejectRetries = new Map<string, number>();
  const rejectTimers = new Set<unknown>();
  /** Unsubscribes we sent and have not yet seen acknowledged (the rest are server-initiated). */
  const expectedUnsubscribed = new Map<string, number>();
  const filter = createStaleFilter();
  const frames = createFrameLimiter(deps.now);
  const bucket = createTokenBucket(deps.now);
  const eventListeners = new Set<(event: RealtimeEvent) => void>();
  const statusListeners = new Set<() => void>();

  // --- listeners (a failing listener must not break the socket handler) -------------------------

  function emit(event: RealtimeEvent): void {
    for (const listener of [...eventListeners]) {
      try {
        listener(event);
      } catch {
        // consumers are isolated from each other and from the connection
      }
    }
  }

  function notifyStatus(): void {
    const status = statusOf(state);
    if (status === lastStatus) return;
    lastStatus = status;
    for (const listener of [...statusListeners]) listener();
  }

  // --- timers -------------------------------------------------------------------------------------

  function clearAllTimers(): void {
    for (const handle of [retryTimer, watchdog, drainTimer, ...rejectTimers]) if (handle !== null) deps.clearTimer(handle);
    retryTimer = null;
    watchdog = null;
    drainTimer = null;
    rejectTimers.clear();
  }

  function armWatchdog(ms: number): void {
    if (watchdog !== null) deps.clearTimer(watchdog);
    watchdogArmedAt = deps.now();
    watchdog = deps.setTimer(() => {
      watchdog = null;
      dropSocket();
      dispatch({ type: 'closed', code: undefined });
    }, ms);
  }

  // --- socket -------------------------------------------------------------------------------------

  function dropSocket(): void {
    const current = socket;
    socket = null;
    if (!current) return;
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    try {
      current.close(NORMAL_CLOSURE);
    } catch {
      // already closed
    }
  }

  /** The next subscribe/unsubscribe chunk that brings the server in line with the screens. */
  function nextGroupFrame(): { payload: string; cost: number; commit: () => void } | null {
    const desired = [...wanted.entries()].slice(0, MAX_GROUPS);
    const desiredKeys = new Set(desired.map(([key]) => key));
    const stale = [...sent.entries()].filter(([key]) => !desiredKeys.has(key));
    if (stale.length > 0) {
      const chunk = planGroupMessages('unsubscribe', stale.map(([, group]) => group).slice(0, 8))[0];
      if (!chunk) return null;
      return {
        ...chunk,
        commit: () => {
          for (const [key] of stale.slice(0, chunk.cost)) {
            sent.delete(key);
            expectedUnsubscribed.set(key, (expectedUnsubscribed.get(key) ?? 0) + 1);
          }
        },
      };
    }
    const fresh = desired.filter(([key]) => !sent.has(key) && !blocked.has(key));
    if (fresh.length === 0) return null;
    const chunk = planGroupMessages('subscribe', fresh.map(([, entry]) => entry.group).slice(0, 8))[0];
    if (!chunk) return null;
    return {
      ...chunk,
      commit: () => {
        for (const [key, entry] of fresh.slice(0, chunk.cost)) sent.set(key, entry.group);
      },
    };
  }

  /**
   * Sends what is owed: a pong first, then group frames computed from the CURRENT wanted/sent
   * state at send time. Nothing is queued, so a release that is undone a moment later (React
   * effect cleanup + resubscribe, overlapping map cells) produces no frames at all.
   */
  function drain(): void {
    if (drainTimer !== null) deps.clearTimer(drainTimer);
    drainTimer = null;
    while (socket && state.phase === 'open') {
      const frame = isPongPending ? { ...PONG_MESSAGE, commit: () => void (isPongPending = false) } : nextGroupFrame();
      if (!frame) return;
      if (!bucket.take(frame.cost)) {
        drainTimer = deps.setTimer(drain, Math.max(MIN_DRAIN_WAIT_MS, bucket.waitMs(frame.cost)));
        return;
      }
      try {
        socket.send(frame.payload);
      } catch {
        return; // the close event follows and the lifecycle reconnects
      }
      frame.commit();
    }
  }

  /** Coalesces churn from one render pass into a single diff. */
  function scheduleDrain(): void {
    if (isDrainQueued) return;
    isDrainQueued = true;
    void Promise.resolve().then(() => {
      isDrainQueued = false;
      drain();
    });
  }

  function onRejected(key: string, code: string): void {
    sent.delete(key);
    blocked.add(key);
    const retries = rejectRetries.get(key) ?? 0;
    const action = rejectAction(code, retries);
    if (action.type === 'give_up') return;
    rejectRetries.set(key, retries + 1);
    const handle = deps.setTimer(() => {
      rejectTimers.delete(handle);
      blocked.delete(key);
      scheduleDrain();
    }, action.afterMs);
    rejectTimers.add(handle);
  }

  function handleGroupAcks(message: Extract<ServerMessage, { type: 'subscribed' | 'unsubscribed' }>): void {
    if (message.type === 'subscribed') {
      for (const rejected of message.rejected) {
        const group = normalizeGroup(rejected);
        if (group) onRejected(groupKey(group), rejected.code);
      }
      return;
    }
    for (const raw of message.groups) {
      const group = normalizeGroup(raw);
      if (!group) continue;
      const key = groupKey(group);
      const expected = expectedUnsubscribed.get(key) ?? 0;
      if (expected > 0) {
        expectedUnsubscribed.set(key, expected - 1);
        continue;
      }
      // The server dropped it on its own (operator access revoked): do not resubscribe in a loop.
      if (sent.has(key)) onRejected(key, 'not_found');
    }
  }

  function handleMessage(message: ServerMessage): void {
    if (message.type === 'ready') {
      dispatch({ type: 'ready' });
      return;
    }
    if (state.phase !== 'open') return;
    switch (message.type) {
      case 'ping':
        isPongPending = true;
        drain();
        return;
      case 'pong':
        return;
      case 'availability':
        if (filter.accept(message.lotId, message.ts)) emit(message);
        return;
      case 'subscribed':
      case 'unsubscribed':
        handleGroupAcks(message);
        emit(message);
        return;
      default:
        emit(message);
    }
  }

  function openSocket(ticket: string): void {
    let opened: SocketLike;
    try {
      opened = deps.openSocket(socketUrl(deps.wsUrl, ticket));
    } catch {
      dispatch({ type: 'closed', code: undefined });
      return;
    }
    socket = opened;
    opened.onmessage = (event) => {
      if (socket !== opened) return;
      // Cap the work a flooding server can cause: excess frames are dropped unparsed.
      if (!frames.allow()) return;
      // Before `ready` only the 15 s connect timeout applies; traffic must not stretch it.
      if (state.phase === 'open' && deps.now() - watchdogArmedAt >= REARM_MIN_GAP_MS) armWatchdog(IDLE_TIMEOUT_MS);
      const message = parseServerMessage(event.data);
      if (message) handleMessage(message);
    };
    opened.onclose = (event) => {
      if (socket !== opened) return;
      socket = null;
      dispatch({ type: 'closed', code: event.code });
    };
    armWatchdog(CONNECT_TIMEOUT_MS);
  }

  // --- lifecycle ----------------------------------------------------------------------------------

  function resetConnectionState(): void {
    sent.clear();
    blocked.clear();
    rejectRetries.clear();
    expectedUnsubscribed.clear();
    isPongPending = false;
  }

  function run(effect: Effect): void {
    switch (effect.type) {
      case 'abort':
        cycle += 1;
        dropSocket();
        clearAllTimers();
        resetConnectionState();
        return;
      case 'fetch_ticket': {
        const mine = cycle;
        deps.fetchTicket().then(
          (ticket) => {
            if (mine === cycle) dispatch({ type: 'ticket_ok', ticket });
          },
          (error: unknown) => {
            if (mine === cycle) dispatch({ type: 'ticket_failed', ...classifyTicketError(error) });
          },
        );
        return;
      }
      case 'open_socket':
        openSocket(effect.ticket);
        return;
      case 'schedule':
        retryTimer = deps.setTimer(() => {
          retryTimer = null;
          dispatch({ type: 'timer' });
        }, effect.ms);
        return;
      case 'refresh_token': {
        const mine = cycle;
        deps.refreshAccess().then(
          (ok) => {
            if (mine === cycle) dispatch({ type: 'refreshed', ok });
          },
          () => {
            if (mine === cycle) dispatch({ type: 'refreshed', ok: false });
          },
        );
        return;
      }
      case 'sync_groups':
        readyCount += 1;
        // The snapshot that follows the subscribe is the new baseline; a restarted server may
        // also have a different clock, so the old timestamps are worthless now.
        filter.clear();
        resetConnectionState();
        armWatchdog(IDLE_TIMEOUT_MS);
        drain();
        if (readyCount > 1) emit({ type: 'resync' });
        return;
    }
  }

  function dispatch(event: LifecycleEvent): void {
    pending.push(event);
    if (isDispatching) return;
    isDispatching = true;
    try {
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        const result = transition(state, next, { nowMs: deps.now(), random: deps.random() });
        state = result.state;
        for (const effect of result.effects) run(effect);
      }
    } finally {
      isDispatching = false;
    }
    notifyStatus();
  }

  // --- public API ---------------------------------------------------------------------------------

  return {
    subscribe(groups) {
      const keys: string[] = [];
      for (const raw of groups) {
        const group = normalizeGroup(raw);
        if (!group) continue;
        const key = groupKey(group);
        const entry = wanted.get(key);
        if (entry) entry.count += 1;
        else wanted.set(key, { group, count: 1 });
        keys.push(key);
      }
      scheduleDrain();
      let isReleased = false;
      return () => {
        if (isReleased) return;
        isReleased = true;
        for (const key of keys) {
          const entry = wanted.get(key);
          if (!entry) continue;
          entry.count -= 1;
          if (entry.count > 0) continue;
          wanted.delete(key);
          if (entry.group.kind !== 'geo') filter.forget(entry.group.id);
        }
        scheduleDrain();
      };
    },
    setSession(userKey) {
      if (userKey !== state.userKey) {
        readyCount = 0;
        filter.clear();
      }
      dispatch({ type: 'session', userKey });
    },
    setForeground: (isForeground) => dispatch({ type: 'foreground', isForeground }),
    notifyOnline: () => dispatch({ type: 'online' }),
    onEvent(listener) {
      eventListeners.add(listener);
      return () => void eventListeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => void statusListeners.delete(listener);
    },
    getStatus: () => statusOf(state),
  };
}
