import { describe, expect, it, vi } from 'vitest';

import {
  CONNECT_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  createRealtimeClient,
  type RealtimeEvent,
  type SocketLike,
} from '@/features/realtime/realtimeClient';
import { TicketError } from '@/features/realtime/ticket';

const LOT_A = '2f9c1b0e-8a54-4c1d-9d3e-0a1b2c3d4e5f';
const LOT_B = '3f9c1b0e-8a54-4c1d-9d3e-0a1b2c3d4e5f';
const OP_LOT = '4f9c1b0e-8a54-4c1d-9d3e-0a1b2c3d4e5f';
const BOOKING = 'e4d0c1de-1111-4222-8333-444455556666';
const ts = (ms: number) => `2026-10-15T13:05:00.${String(ms).padStart(3, '0')}Z`;

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closedWith: number | undefined;
  isClosed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.isClosed = true;
    this.closedWith = code;
  }
  // test helpers
  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }
  serverClose(code: number): void {
    this.onclose?.({ code });
  }
  get frames(): { type: string; groups?: { kind: string; id: string }[] }[] {
    return this.sent.map((s) => JSON.parse(s) as { type: string });
  }
}

function harness(overrides: { fetchTicket?: () => Promise<string>; refreshAccess?: () => Promise<boolean> } = {}) {
  let nowMs = 1_000_000;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const sockets: FakeSocket[] = [];
  let ticketNo = 0;
  const fetchTicket = vi.fn(overrides.fetchTicket ?? (async () => `ticket-${(ticketNo += 1)}-abcdefghijklmnop`));
  const refreshAccess = vi.fn(overrides.refreshAccess ?? (async () => true));

  const client = createRealtimeClient({
    wsUrl: 'wss://api.parkbor.uz/ws',
    fetchTicket,
    openSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    refreshAccess,
    now: () => nowMs,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      nextId += 1;
      timers.set(nextId, { at: nowMs + ms, fn });
      return nextId;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
  });

  const events: RealtimeEvent[] = [];
  client.onEvent((event) => events.push(event));

  /** Moves the clock, firing due timers in order. */
  function advance(ms: number): void {
    const target = nowMs + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      nowMs = Math.max(nowMs, due[1].at);
      due[1].fn();
    }
    nowMs = target;
  }
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const last = () => sockets[sockets.length - 1] as FakeSocket;
  /** Signed in, ticket fetched, socket open, server said ready. */
  async function goLive(userKey = 'u1') {
    client.setSession(userKey);
    await flush();
    last().receive({ type: 'ready' });
  }
  return { client, events, sockets, last, advance, flush, goLive, fetchTicket, refreshAccess, timers };
}

describe('connecting', () => {
  it('fetches a ticket, connects to <ws>/availability/?ticket=, and is live after ready', async () => {
    const h = harness();
    expect(h.client.getStatus()).toBe('off');
    h.client.setSession('u1');
    expect(h.client.getStatus()).toBe('connecting');
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().url).toBe('wss://api.parkbor.uz/ws/availability/?ticket=ticket-1-abcdefghijklmnop');
    h.last().receive({ type: 'ready' });
    expect(h.client.getStatus()).toBe('live');
  });

  it('notifies status listeners only when the status changes', async () => {
    const h = harness();
    const listener = vi.fn();
    const off = h.client.onStatus(listener);
    await h.goLive();
    const calls = listener.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2); // connecting, live
    h.last().receive({ type: 'pong' });
    expect(listener.mock.calls.length).toBe(calls);
    off();
    h.client.setSession(null);
    expect(listener.mock.calls.length).toBe(calls);
  });

  it('does not connect without a session or in the background', async () => {
    const h = harness();
    h.client.setForeground(false);
    h.client.setSession('u1');
    await h.flush();
    expect(h.fetchTicket).not.toHaveBeenCalled();
  });

  it('ignores a ticket that arrives after logout (stale work is invalidated)', async () => {
    let resolve: (ticket: string) => void = () => undefined;
    const h = harness({ fetchTicket: () => new Promise<string>((r) => (resolve = r)) });
    h.client.setSession('u1');
    h.client.setSession(null);
    resolve('late-ticket-abcdefghijklmnop');
    await h.flush();
    expect(h.sockets).toHaveLength(0);
  });

  it('survives openSocket throwing by backing off', async () => {
    const timers: (() => void)[] = [];
    const client = createRealtimeClient({
      wsUrl: 'wss://h/ws',
      fetchTicket: async () => 'ticket-abcdefghijklmnop',
      openSocket: () => {
        throw new Error('no network');
      },
      refreshAccess: async () => true,
      now: () => 0,
      random: () => 0.5,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
    });
    client.setSession('u1');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getStatus()).toBe('waiting');
    expect(timers).toHaveLength(1);
  });
});

describe('subscriptions', () => {
  it('sends subscribe only after ready, for groups wanted before connecting', async () => {
    const h = harness();
    h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    h.client.setSession('u1');
    await h.flush();
    expect(h.last().sent).toEqual([]);
    h.last().receive({ type: 'ready' });
    expect(h.last().frames).toEqual([{ type: 'subscribe', groups: [{ kind: 'lot', id: LOT_A }] }]);
  });

  it('subscribes new groups right away when live and unsubscribes on release', async () => {
    const h = harness();
    await h.goLive();
    const release = h.client.subscribe([{ kind: 'geo', id: 'ttvw5' }]);
    await h.flush();
    expect(h.last().frames).toEqual([{ type: 'subscribe', groups: [{ kind: 'geo', id: 'ttvw5' }] }]);
    release();
    await h.flush();
    expect(h.last().frames.at(-1)).toEqual({ type: 'unsubscribe', groups: [{ kind: 'geo', id: 'ttvw5' }] });
  });

  it('reference-counts a group wanted by two screens', async () => {
    const h = harness();
    await h.goLive();
    const a = h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    const b = h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    await h.flush();
    expect(h.last().frames).toHaveLength(1);
    a();
    await h.flush();
    expect(h.last().frames).toHaveLength(1);
    a(); // releasing twice is harmless
    await h.flush();
    expect(h.last().frames).toHaveLength(1);
    b();
    await h.flush();
    expect(h.last().frames.at(-1)?.type).toBe('unsubscribe');
  });

  it('drops invalid groups instead of sending them', async () => {
    const h = harness();
    await h.goLive();
    h.client.subscribe([
      { kind: 'lot', id: 'not-a-uuid' },
      { kind: 'user', id: LOT_A },
      { kind: 'geo', id: 'ttvw' },
    ]);
    expect(h.last().sent).toEqual([]);
  });

  it('sends the 50-group maximum in paced chunks the server rate limit allows', async () => {
    const h = harness();
    await h.goLive();
    const groups = Array.from({ length: 60 }, (_, i) => ({ kind: 'lot', id: `2f9c1b0e-8a54-4c1d-9d3e-${String(i).padStart(12, '0')}` }));
    h.client.subscribe(groups);
    await h.flush();
    const sentGroups = () => h.last().frames.flatMap((f) => f.groups ?? []).length;
    expect(sentGroups()).toBeLessThan(50); // first burst only
    for (const frame of h.last().frames) expect(frame.groups?.length).toBeLessThanOrEqual(8);
    h.advance(10_000);
    expect(sentGroups()).toBe(50);
  });

  it('never exceeds the bucket within any one second', async () => {
    const h = harness();
    await h.goLive();
    const groups = Array.from({ length: 50 }, (_, i) => ({ kind: 'lot', id: `2f9c1b0e-8a54-4c1d-9d3e-${String(i).padStart(12, '0')}` }));
    h.client.subscribe(groups);
    await h.flush();
    const afterBurst = h.last().sent.length;
    h.advance(500);
    const costWithinHalfSecond = h.last().frames.slice(0, h.last().sent.length).flatMap((f) => f.groups ?? []).length;
    expect(costWithinHalfSecond).toBeLessThanOrEqual(8 + 4 + 8); // burst + refill of half a second, rounded up by chunk size
    expect(afterBurst).toBeGreaterThan(0);
  });

  it('resubscribes every active group after a reconnect, with a NEW ticket', async () => {
    const h = harness();
    await h.goLive();
    h.client.subscribe([
      { kind: 'lot', id: LOT_A },
      { kind: 'geo', id: 'ttvw5' },
    ]);
    const first = h.last();
    first.serverClose(1006);
    expect(h.client.getStatus()).toBe('waiting');
    h.advance(2000);
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.fetchTicket).toHaveBeenCalledTimes(2);
    expect(h.last().url).not.toBe(first.url);
    expect(h.last().sent).toEqual([]);
    h.last().receive({ type: 'ready' });
    expect(h.last().frames).toEqual([
      {
        type: 'subscribe',
        groups: [
          { kind: 'lot', id: LOT_A },
          { kind: 'geo', id: 'ttvw5' },
        ],
      },
    ]);
  });

  it('drops groups released while disconnected from the resubscribe', async () => {
    const h = harness();
    await h.goLive();
    const release = h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    h.last().serverClose(1006);
    release();
    h.advance(2000);
    await h.flush();
    h.last().receive({ type: 'ready' });
    expect(h.last().sent).toEqual([]);
  });
});

/** Moves the clock in 30 s steps with a server ping each, so the idle watchdog stays quiet. */
function quiet(h: ReturnType<typeof harness>, ms: number): void {
  for (let left = ms; left > 0; left -= 30_000) {
    h.advance(Math.min(30_000, left));
    h.last().receive({ type: 'ping' });
  }
}

describe('subscription churn and acknowledgements', () => {
  it('release + resubscribe in one pass sends nothing (overlapping map cells stay subscribed)', async () => {
    const h = harness();
    await h.goLive();
    const release = h.client.subscribe([{ kind: 'geo', id: 'ttvw5' }]);
    await h.flush();
    const before = h.last().sent.length;
    release();
    h.client.subscribe([{ kind: 'geo', id: 'ttvw5' }]);
    await h.flush();
    expect(h.last().sent.length).toBe(before);
  });

  it('subscribe + release before anything was sent cancels out', async () => {
    const h = harness();
    await h.goLive();
    h.client.subscribe([{ kind: 'lot', id: LOT_A }])();
    await h.flush();
    expect(h.last().sent).toEqual([]);
  });

  it('only the changed cells are sent when the set moves', async () => {
    const h = harness();
    await h.goLive();
    const first = h.client.subscribe([{ kind: 'geo', id: 'ttvw5' }, { kind: 'geo', id: 'ttvw7' }]);
    await h.flush();
    first();
    h.client.subscribe([{ kind: 'geo', id: 'ttvw7' }, { kind: 'geo', id: 'ttvwe' }]);
    await h.flush();
    expect(h.last().frames.slice(1)).toEqual([
      { type: 'unsubscribe', groups: [{ kind: 'geo', id: 'ttvw5' }] },
      { type: 'subscribe', groups: [{ kind: 'geo', id: 'ttvwe' }] },
    ]);
  });

  it('does not resend what the server already holds', async () => {
    const h = harness();
    await h.goLive();
    h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    await h.flush();
    h.client.subscribe([{ kind: 'lot', id: LOT_B }]);
    await h.flush();
    expect(h.last().frames[1]).toEqual({ type: 'subscribe', groups: [{ kind: 'lot', id: LOT_B }] });
  });

  it('retries a not_found group once after the negative cache, then gives up', async () => {
    const h = harness();
    await h.goLive();
    h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    await h.flush();
    h.last().receive({ type: 'subscribed', groups: [], rejected: [{ kind: 'lot', id: LOT_A, code: 'not_found' }] });
    h.advance(30_000);
    await h.flush();
    expect(h.last().frames).toHaveLength(1);
    h.advance(1000);
    await h.flush();
    expect(h.last().frames.filter((f) => f.type === 'subscribe')).toHaveLength(2);
    h.last().receive({ type: 'subscribed', groups: [], rejected: [{ kind: 'lot', id: LOT_A, code: 'not_found' }] });
    quiet(h, 10 * 60_000);
    await h.flush();
    expect(h.last().frames.filter((f) => f.type === 'subscribe')).toHaveLength(2);
  });

  it('never retries a malformed or over-the-cap group', async () => {
    const h = harness();
    await h.goLive();
    h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    await h.flush();
    h.last().receive({ type: 'subscribed', groups: [], rejected: [{ kind: 'lot', id: LOT_A, code: 'too_many_groups' }] });
    quiet(h, 10 * 60_000);
    await h.flush();
    expect(h.last().frames.filter((f) => f.type === 'subscribe')).toHaveLength(1);
  });

  it('a rejected group is tried again on the next connection', async () => {
    const h = harness();
    await h.goLive();
    h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    await h.flush();
    h.last().receive({ type: 'subscribed', groups: [], rejected: [{ kind: 'lot', id: LOT_A, code: 'invalid_group' }] });
    h.last().serverClose(1006);
    h.advance(2000);
    await h.flush();
    h.last().receive({ type: 'ready' });
    expect(h.last().frames).toHaveLength(1);
  });

  it('an unsolicited unsubscribed (access revoked) is not resubscribed in a loop', async () => {
    const h = harness();
    await h.goLive();
    h.client.subscribe([{ kind: 'operator_lot', id: OP_LOT }]);
    await h.flush();
    h.last().receive({ type: 'unsubscribed', groups: [{ kind: 'operator_lot', id: OP_LOT }] });
    await h.flush();
    expect(h.last().frames).toHaveLength(1);
    h.advance(31_000);
    await h.flush();
    expect(h.last().frames).toHaveLength(2); // the single late retry
    h.last().receive({ type: 'unsubscribed', groups: [{ kind: 'operator_lot', id: OP_LOT }] });
    quiet(h, 10 * 60_000);
    await h.flush();
    expect(h.last().frames.filter((f) => f.type === 'subscribe')).toHaveLength(2);
  });

  it('the acknowledgement of our own unsubscribe is not mistaken for a server-side drop', async () => {
    const h = harness();
    await h.goLive();
    const release = h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    await h.flush();
    release();
    await h.flush();
    h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    await h.flush();
    const sentBefore = h.last().sent.length;
    h.last().receive({ type: 'unsubscribed', groups: [{ kind: 'lot', id: LOT_A }] });
    await h.flush();
    expect(h.last().sent.length).toBe(sentBefore);
  });
});

describe('inbound limits and watchdog', () => {
  it('drops frames beyond 50 per second', async () => {
    const h = harness();
    await h.goLive();
    for (let i = 0; i < 80; i += 1) {
      h.last().receive({ type: 'booking_status', booking_id: BOOKING, status: 'ACTIVE' });
    }
    // 50 frames per second in total, and the `ready` frame of goLive() was the first of them.
    expect(h.events.filter((e) => e.type === 'booking_status')).toHaveLength(49);
    h.advance(1000);
    h.last().receive({ type: 'booking_status', booking_id: BOOKING, status: 'ACTIVE' });
    expect(h.events.filter((e) => e.type === 'booking_status')).toHaveLength(50);
  });

  it('pre-ready traffic does not extend the 15 s connect timeout', async () => {
    const h = harness();
    h.client.setSession('u1');
    await h.flush();
    for (let t = 0; t < 14; t += 1) {
      h.advance(1000);
      h.last().receive({ type: 'ping' });
    }
    h.advance(1000);
    expect(h.client.getStatus()).toBe('waiting');
  });

  it('a steady stream cannot postpone the idle timeout more often than once a second', async () => {
    const h = harness();
    await h.goLive();
    let timers = 0;
    for (let i = 0; i < 20; i += 1) {
      h.advance(100);
      h.last().receive({ type: 'pong' });
      timers = h.timers.size;
    }
    expect(timers).toBeLessThanOrEqual(2);
  });
});

describe('messages', () => {
  it('answers the server ping with a pong, ahead of queued subscribes', async () => {
    const h = harness();
    await h.goLive();
    h.last().receive({ type: 'ping' });
    expect(h.last().frames).toEqual([{ type: 'pong' }]);
  });

  it('emits availability, slot_status, booking_status, subscribed and error', async () => {
    const h = harness();
    await h.goLive();
    const s = h.last();
    s.receive({ type: 'availability', lot_id: LOT_A, free_slots: 3, total_slots: 10, ts: ts(1) });
    s.receive({ type: 'slot_status', lot_id: OP_LOT, slot_id: LOT_B, status: 'FREE' });
    s.receive({ type: 'booking_status', booking_id: BOOKING, status: 'CONFIRMED' });
    s.receive({ type: 'subscribed', groups: [{ kind: 'lot', id: LOT_A }], rejected: [{ kind: 'lot', id: LOT_B, code: 'not_found' }] });
    s.receive({ type: 'error', code: 'invalid_groups' });
    expect(h.events.map((e) => e.type)).toEqual(['availability', 'slot_status', 'booking_status', 'subscribed', 'error']);
  });

  it('drops an availability older than one already applied (stale after the snapshot)', async () => {
    const h = harness();
    await h.goLive();
    const s = h.last();
    s.receive({ type: 'availability', lot_id: LOT_A, free_slots: 3, total_slots: 10, ts: ts(500) });
    s.receive({ type: 'availability', lot_id: LOT_A, free_slots: 9, total_slots: 10, ts: ts(100) });
    s.receive({ type: 'availability', lot_id: LOT_A, free_slots: 2, total_slots: 10, ts: ts(600) });
    expect(h.events.map((e) => (e.type === 'availability' ? e.freeSlots : -1))).toEqual([3, 2]);
  });

  it('ignores malformed, oversized and binary frames without disturbing the connection', async () => {
    const h = harness();
    await h.goLive();
    const s = h.last();
    s.receive('{not json');
    s.receive({ type: 'availability', lot_id: 'x' });
    s.receive('x'.repeat(100_000));
    s.onmessage?.({ data: new ArrayBuffer(8) });
    expect(h.events).toEqual([]);
    expect(h.client.getStatus()).toBe('live');
    expect(s.isClosed).toBe(false);
  });

  it('ignores data frames before ready', async () => {
    const h = harness();
    h.client.setSession('u1');
    await h.flush();
    h.last().receive({ type: 'availability', lot_id: LOT_A, free_slots: 3, total_slots: 10, ts: ts(1) });
    expect(h.events).toEqual([]);
  });

  it('emits resync only when it connects again, and resets the stale baseline', async () => {
    const h = harness();
    await h.goLive();
    expect(h.events.some((e) => e.type === 'resync')).toBe(false);
    h.last().receive({ type: 'availability', lot_id: LOT_A, free_slots: 3, total_slots: 10, ts: ts(900) });
    h.last().serverClose(1011);
    h.advance(2000);
    await h.flush();
    h.last().receive({ type: 'ready' });
    expect(h.events.filter((e) => e.type === 'resync')).toHaveLength(1);
    // The new connection's snapshot is the baseline even though its ts is older than before.
    h.last().receive({ type: 'availability', lot_id: LOT_A, free_slots: 5, total_slots: 10, ts: ts(100) });
    expect(h.events.filter((e) => e.type === 'availability')).toHaveLength(2);
  });

  it('a throwing listener does not stop the others or the connection', async () => {
    const h = harness();
    h.client.onEvent(() => {
      throw new Error('boom');
    });
    const seen = vi.fn();
    h.client.onEvent(seen);
    await h.goLive();
    h.last().receive({ type: 'booking_status', booking_id: BOOKING, status: 'ACTIVE' });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(h.client.getStatus()).toBe('live');
  });

  it('stops delivering to a listener that unsubscribed', async () => {
    const h = harness();
    const seen = vi.fn();
    const off = h.client.onEvent(seen);
    await h.goLive();
    off();
    h.last().receive({ type: 'booking_status', booking_id: BOOKING, status: 'ACTIVE' });
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('close codes', () => {
  it.each([4400, 1009, 4409, 4429])('%i: no automatic reconnect', async (code) => {
    const h = harness();
    await h.goLive();
    h.last().serverClose(code);
    expect(h.client.getStatus()).toBe('stopped');
    h.advance(10 * 60_000);
    await h.flush();
    expect(h.fetchTicket).toHaveBeenCalledTimes(1);
    expect(h.sockets).toHaveLength(1);
  });

  it.each([4408, 1011, 1013, 1006])('%i: reconnects with a new ticket after a backoff', async (code) => {
    const h = harness();
    await h.goLive();
    h.last().serverClose(code);
    expect(h.client.getStatus()).toBe('waiting');
    h.advance(1000);
    await h.flush();
    expect(h.fetchTicket).toHaveBeenCalledTimes(2);
    expect(h.sockets).toHaveLength(2);
  });

  it('4410: reconnects almost immediately', async () => {
    const h = harness();
    await h.goLive();
    h.last().serverClose(4410);
    h.advance(300);
    await h.flush();
    expect(h.sockets).toHaveLength(2);
  });

  it('backoff grows while connecting keeps failing, and a ready resets it', async () => {
    const h = harness();
    h.client.setSession('u1');
    await h.flush();
    h.last().serverClose(1006); // attempt 1 -> 1 s
    h.advance(999);
    await h.flush();
    expect(h.sockets).toHaveLength(1);
    h.advance(1);
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    h.last().serverClose(1006); // attempt 2 -> 2 s
    h.advance(1999);
    await h.flush();
    expect(h.sockets).toHaveLength(2);
    h.advance(1);
    await h.flush();
    expect(h.sockets).toHaveLength(3);
    h.last().receive({ type: 'ready' });
    h.advance(30_000); // stayed up long enough: the backoff starts over
    h.last().serverClose(1006); // reset -> 1 s again
    h.advance(1000);
    await h.flush();
    expect(h.sockets).toHaveLength(4);
  });

  it('4401: refreshes the token once, then takes a new ticket', async () => {
    const h = harness();
    await h.goLive();
    h.last().serverClose(4401);
    await h.flush();
    expect(h.refreshAccess).toHaveBeenCalledTimes(1);
    await h.flush();
    expect(h.fetchTicket).toHaveBeenCalledTimes(2);
    expect(h.sockets).toHaveLength(2);
    h.last().serverClose(4401); // refused again without a ready in between
    await h.flush();
    expect(h.refreshAccess).toHaveBeenCalledTimes(1);
    expect(h.client.getStatus()).toBe('stopped');
  });

  it('4401 with a failed refresh stops', async () => {
    const h = harness({ refreshAccess: async () => false });
    await h.goLive();
    h.last().serverClose(4401);
    await h.flush();
    expect(h.client.getStatus()).toBe('stopped');
    expect(h.fetchTicket).toHaveBeenCalledTimes(1);
  });

  it('4401 with a rejecting refresh stops', async () => {
    const h = harness({ refreshAccess: () => Promise.reject(new Error('net')) });
    await h.goLive();
    h.last().serverClose(4401);
    await h.flush();
    expect(h.client.getStatus()).toBe('stopped');
  });
});

describe('ticket failures', () => {
  it('401/403 from the ticket endpoint stops (the session is over)', async () => {
    const h = harness({ fetchTicket: () => Promise.reject(new TicketError('auth')) });
    h.client.setSession('u1');
    await h.flush();
    expect(h.client.getStatus()).toBe('stopped');
    h.advance(120_000);
    await h.flush();
    expect(h.fetchTicket).toHaveBeenCalledTimes(1);
  });

  it('429 waits for Retry-After before the next ticket', async () => {
    const h = harness({ fetchTicket: () => Promise.reject(new TicketError('rate_limited', 20_000)) });
    h.client.setSession('u1');
    await h.flush();
    h.advance(19_999);
    await h.flush();
    expect(h.fetchTicket).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.flush();
    expect(h.fetchTicket).toHaveBeenCalledTimes(2);
  });

  it('an unclassified error (network) retries with backoff', async () => {
    let calls = 0;
    const h = harness({
      fetchTicket: async () => {
        calls += 1;
        if (calls === 1) throw new Error('network');
        return 'ticket-2-abcdefghijklmnop';
      },
    });
    h.client.setSession('u1');
    await h.flush();
    expect(h.client.getStatus()).toBe('waiting');
    h.advance(1000);
    await h.flush();
    expect(h.sockets).toHaveLength(1);
  });

  it('coming back online retries without waiting out the backoff', async () => {
    let calls = 0;
    const h = harness({
      fetchTicket: async () => {
        calls += 1;
        if (calls === 1) throw new Error('network');
        return 'ticket-2-abcdefghijklmnop';
      },
    });
    h.client.setSession('u1');
    await h.flush();
    h.advance(5000); // past the minimum interval (the 1 s backoff timer fires and retries too)
    h.client.notifyOnline();
    await h.flush();
    expect(h.sockets).toHaveLength(1);
  });
});

describe('app state', () => {
  it('closes the socket in the background and does not reconnect until the app returns', async () => {
    const h = harness();
    await h.goLive();
    const socket = h.last();
    h.client.setForeground(false);
    expect(socket.isClosed).toBe(true);
    expect(h.client.getStatus()).toBe('off');
    h.advance(10 * 60_000);
    await h.flush();
    expect(h.fetchTicket).toHaveBeenCalledTimes(1);
    h.client.setForeground(true);
    await h.flush();
    expect(h.fetchTicket).toHaveBeenCalledTimes(2);
    h.last().receive({ type: 'ready' });
    expect(h.client.getStatus()).toBe('live');
  });

  it('resubscribes after coming back to the foreground', async () => {
    const h = harness();
    await h.goLive();
    h.client.subscribe([{ kind: 'lot', id: LOT_A }]);
    h.client.setForeground(false);
    h.client.setForeground(true);
    await h.flush();
    h.last().receive({ type: 'ready' });
    expect(h.last().frames).toEqual([{ type: 'subscribe', groups: [{ kind: 'lot', id: LOT_A }] }]);
  });

  it('logout closes the socket and a different account gets its own connection', async () => {
    const h = harness();
    await h.goLive('u1');
    const first = h.last();
    h.client.setSession(null);
    expect(first.isClosed).toBe(true);
    await h.goLive('u2');
    expect(h.sockets).toHaveLength(2);
    expect(h.client.getStatus()).toBe('live');
  });
});

describe('watchdogs', () => {
  it('reconnects when the server falls silent for too long (half-open link)', async () => {
    const h = harness();
    await h.goLive();
    h.advance(IDLE_TIMEOUT_MS - 1);
    expect(h.client.getStatus()).toBe('live');
    h.advance(1);
    expect(h.client.getStatus()).toBe('waiting');
    expect(h.sockets[0]?.isClosed).toBe(true);
  });

  it('any inbound message postpones the idle timeout', async () => {
    const h = harness();
    await h.goLive();
    h.advance(IDLE_TIMEOUT_MS - 1000);
    h.last().receive({ type: 'ping' });
    h.advance(IDLE_TIMEOUT_MS - 1000);
    expect(h.client.getStatus()).toBe('live');
  });

  it('gives up on a socket that never says ready', async () => {
    const h = harness();
    h.client.setSession('u1');
    await h.flush();
    h.advance(CONNECT_TIMEOUT_MS);
    expect(h.client.getStatus()).toBe('waiting');
    expect(h.sockets[0]?.isClosed).toBe(true);
  });
});

describe('late events from a replaced socket', () => {
  it('are ignored', async () => {
    const h = harness();
    await h.goLive();
    const old = h.last();
    old.serverClose(1006);
    h.advance(2000);
    await h.flush();
    const current = h.last();
    old.receive({ type: 'booking_status', booking_id: BOOKING, status: 'ACTIVE' });
    old.serverClose(4400);
    expect(h.events.filter((e) => e.type === 'booking_status')).toEqual([]);
    expect(h.client.getStatus()).toBe('connecting');
    expect(current.isClosed).toBe(false);
  });
});
