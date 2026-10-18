import { describe, expect, it } from 'vitest';

import {
  GROUPS_PER_MESSAGE,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_GROUPS,
  MAX_SERVER_MESSAGE_CHARS,
  groupKey,
  normalizeGroup,
  parseServerMessage,
  planGroupMessages,
  type Group,
} from '@/features/realtime/protocol';

const LOT = '2f9c1b0e-8a54-4c1d-9d3e-0a1b2c3d4e5f';
const SLOT = '3a9c1b0e-8a54-4c1d-9d3e-0a1b2c3d4e5f';
const BOOKING = 'e4d0c1de-1111-4222-8333-444455556666';
const TS = '2026-10-15T13:05:00.123Z';

const parse = (value: unknown) => parseServerMessage(JSON.stringify(value));

describe('parseServerMessage', () => {
  it('parses ready, pong and ping', () => {
    expect(parse({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parse({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(parse({ type: 'pong' })).toEqual({ type: 'pong' });
  });

  it('parses availability and keeps the ts string untouched', () => {
    expect(parse({ type: 'availability', lot_id: LOT, free_slots: 7, total_slots: 50, ts: TS })).toEqual({
      type: 'availability',
      lotId: LOT,
      freeSlots: 7,
      totalSlots: 50,
      ts: TS,
    });
  });

  it('lower-cases ids so cache keys match', () => {
    const msg = parse({ type: 'availability', lot_id: LOT.toUpperCase(), free_slots: 0, total_slots: 0, ts: TS });
    expect(msg).toMatchObject({ lotId: LOT });
  });

  it.each([
    ['negative free_slots', { free_slots: -1 }],
    ['fractional free_slots', { free_slots: 1.5 }],
    ['string free_slots', { free_slots: '7' }],
    ['huge total', { total_slots: 10_000_000 }],
    ['ts without milliseconds', { ts: '2026-10-15T13:05:00Z' }],
    ['ts with offset', { ts: '2026-10-15T13:05:00.123+05:00' }],
    ['non uuid lot', { lot_id: 'not-a-uuid' }],
    ['missing ts', { ts: undefined }],
  ])('rejects availability with %s', (_name, patch) => {
    const base = { type: 'availability', lot_id: LOT, free_slots: 7, total_slots: 50, ts: TS };
    expect(parse({ ...base, ...patch })).toBeNull();
  });

  it('parses slot_status and booking_status', () => {
    expect(parse({ type: 'slot_status', lot_id: LOT, slot_id: SLOT, status: 'OCCUPIED' })).toEqual({
      type: 'slot_status',
      lotId: LOT,
      slotId: SLOT,
      status: 'OCCUPIED',
    });
    expect(parse({ type: 'booking_status', booking_id: BOOKING, status: 'CONFIRMED' })).toEqual({
      type: 'booking_status',
      bookingId: BOOKING,
      status: 'CONFIRMED',
    });
  });

  it('rejects slot_status / booking_status with bad ids or oversized status', () => {
    expect(parse({ type: 'slot_status', lot_id: LOT, slot_id: 'x', status: 'FREE' })).toBeNull();
    expect(parse({ type: 'booking_status', booking_id: '../me', status: 'CONFIRMED' })).toBeNull();
    expect(parse({ type: 'booking_status', booking_id: BOOKING, status: 'X'.repeat(100) })).toBeNull();
    expect(parse({ type: 'booking_status', booking_id: BOOKING })).toBeNull();
  });

  it('parses subscribed with accepted and rejected groups', () => {
    const msg = parse({
      type: 'subscribed',
      groups: [{ kind: 'lot', id: LOT }],
      rejected: [{ kind: 'user', id: 'x', code: 'invalid_kind' }],
    });
    expect(msg).toEqual({
      type: 'subscribed',
      groups: [{ kind: 'lot', id: LOT }],
      rejected: [{ kind: 'user', id: 'x', code: 'invalid_kind' }],
    });
  });

  it('treats a missing rejected list as empty and unsubscribed likewise', () => {
    expect(parse({ type: 'subscribed', groups: [] })).toEqual({ type: 'subscribed', groups: [], rejected: [] });
    expect(parse({ type: 'unsubscribed', groups: [{ kind: 'geo', id: 'ttvw5' }] })).toEqual({
      type: 'unsubscribed',
      groups: [{ kind: 'geo', id: 'ttvw5' }],
    });
  });

  it('rejects subscribed with an unknown group kind or non-array groups', () => {
    expect(parse({ type: 'subscribed', groups: [{ kind: 'user', id: LOT }], rejected: [] })).toBeNull();
    expect(parse({ type: 'subscribed', groups: 'lot_x', rejected: [] })).toBeNull();
  });

  it('parses error codes and keeps unknown codes', () => {
    expect(parse({ type: 'error', code: 'unknown_type' })).toEqual({ type: 'error', code: 'unknown_type' });
    expect(parse({ type: 'error', code: 'brand_new' })).toEqual({ type: 'error', code: 'brand_new' });
    expect(parse({ type: 'error' })).toBeNull();
  });

  it('ignores unknown types and extra fields safely', () => {
    expect(parse({ type: 'mystery' })).toBeNull();
    expect(parse({ type: 'ready', extra: 1 })).toEqual({ type: 'ready' });
  });

  it('rejects non-JSON, non-object, binary and non-string frames', () => {
    expect(parseServerMessage('{oops')).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
    expect(parseServerMessage('[]')).toBeNull();
    expect(parseServerMessage('"ready"')).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(4))).toBeNull();
    expect(parseServerMessage(undefined)).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
  });

  it('rejects oversized frames before parsing them', () => {
    const padding = 'a'.repeat(MAX_SERVER_MESSAGE_CHARS);
    expect(parseServerMessage(JSON.stringify({ type: 'error', code: padding }))).toBeNull();
  });
});

describe('normalizeGroup / groupKey', () => {
  it('accepts lot, operator_lot (uuid) and geo (geohash5) and lower-cases', () => {
    expect(normalizeGroup({ kind: 'lot', id: LOT.toUpperCase() })).toEqual({ kind: 'lot', id: LOT });
    expect(normalizeGroup({ kind: 'operator_lot', id: LOT })).toEqual({ kind: 'operator_lot', id: LOT });
    expect(normalizeGroup({ kind: 'geo', id: 'TTVW5' })).toEqual({ kind: 'geo', id: 'ttvw5' });
  });

  it('rejects malformed ids and unknown kinds', () => {
    expect(normalizeGroup({ kind: 'lot', id: 'nope' })).toBeNull();
    expect(normalizeGroup({ kind: 'geo', id: 'ttvw' })).toBeNull();
    expect(normalizeGroup({ kind: 'geo', id: 'ttvwa' })).toBeNull(); // 'a' is not in the geohash alphabet
    expect(normalizeGroup({ kind: 'geo', id: 'ttvw55' })).toBeNull();
    expect(normalizeGroup({ kind: 'user' as never, id: LOT })).toBeNull();
  });

  it('builds a stable key', () => {
    expect(groupKey({ kind: 'geo', id: 'ttvw5' })).toBe('geo:ttvw5');
  });
});

describe('planGroupMessages', () => {
  const lots = (n: number): Group[] =>
    Array.from({ length: n }, (_, i) => ({ kind: 'lot' as const, id: `2f9c1b0e-8a54-4c1d-9d3e-${String(i).padStart(12, '0')}` }));

  it('returns nothing for no groups', () => {
    expect(planGroupMessages('subscribe', [])).toEqual([]);
  });

  it('splits into messages of at most GROUPS_PER_MESSAGE, each with its element cost', () => {
    const plan = planGroupMessages('subscribe', lots(GROUPS_PER_MESSAGE * 2 + 1));
    expect(plan.map((m) => m.cost)).toEqual([GROUPS_PER_MESSAGE, GROUPS_PER_MESSAGE, 1]);
  });

  it('never exceeds the server group cap even if more are passed', () => {
    const plan = planGroupMessages('subscribe', lots(80));
    expect(plan.reduce((sum, m) => sum + m.cost, 0)).toBe(MAX_GROUPS);
  });

  it('keeps every frame under 4 KB and valid JSON of the documented shape', () => {
    const plan = planGroupMessages('unsubscribe', lots(MAX_GROUPS));
    for (const message of plan) {
      expect(message.payload.length).toBeLessThanOrEqual(MAX_CLIENT_MESSAGE_BYTES);
      const json = JSON.parse(message.payload) as { type: string; groups: Group[] };
      expect(json.type).toBe('unsubscribe');
      expect(json.groups[0]).toEqual({ kind: 'lot', id: expect.any(String) });
    }
  });
});
