import { z } from 'zod';

import { isUuid } from '@/lib/contract';

// WebSocket protocol of ARCHITECTURE 12.0. Everything that comes off the socket is untrusted text:
// it is size-capped, parsed with zod and dropped (never thrown) when it does not match.

export const MAX_CLIENT_MESSAGE_BYTES = 4096;
/** Server frames are small (a snapshot is ~150 bytes); anything this big is not ours. */
export const MAX_SERVER_MESSAGE_CHARS = 16_384;
/** Server cap per connection (WS_MAX_GROUPS_PER_CONNECTION). */
export const MAX_GROUPS = 50;
/**
 * Groups per subscribe/unsubscribe frame. The documented limit is 50 per frame, but the server
 * charges one token per element from a bucket of 10 and takes the first token separately, so a
 * frame naming 11+ groups is always rated out (4429). Eight per frame stays safely inside it.
 */
export const GROUPS_PER_MESSAGE = 8;
const MAX_SLOT_COUNT = 1_000_000;

export type GroupKind = 'lot' | 'geo' | 'operator_lot';

export interface Group {
  kind: GroupKind;
  id: string;
}

const GEOHASH5 = /^[0-9b-hjkmnp-z]{5}$/;
/** `2026-10-15T13:05:00.123Z`: fixed width, so plain string comparison orders instants. */
const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KINDS: readonly GroupKind[] = ['lot', 'geo', 'operator_lot'];

export function groupKey(group: Group): string {
  return `${group.kind}:${group.id}`;
}

/** A well-formed group in canonical (lower-case) form, or null. Invalid groups are never sent. */
export function normalizeGroup(group: { kind: string; id: string }): Group | null {
  const id = typeof group.id === 'string' ? group.id.toLowerCase() : '';
  if (group.kind === 'geo') return GEOHASH5.test(id) ? { kind: 'geo', id } : null;
  if (group.kind === 'lot' || group.kind === 'operator_lot') return isUuid(id) ? { kind: group.kind, id } : null;
  return null;
}

// --- server -> client ----------------------------------------------------------------------------

const uuid = z.string().refine(isUuid, 'uuid').transform((value) => value.toLowerCase());
const count = z.number().int().min(0).max(MAX_SLOT_COUNT);
const groupSchema = z.object({ kind: z.enum(KINDS), id: z.string().max(64) });
const rejectedSchema = z.object({ kind: z.string().max(32), id: z.string().max(64), code: z.string().max(32) });

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('pong') }),
  z.object({
    type: z.literal('subscribed'),
    groups: z.array(groupSchema).max(100),
    rejected: z.array(rejectedSchema).max(100).optional(),
  }),
  z.object({ type: z.literal('unsubscribed'), groups: z.array(groupSchema).max(100) }),
  z.object({
    type: z.literal('availability'),
    lot_id: uuid,
    free_slots: count,
    total_slots: count,
    ts: z.string().regex(TS_PATTERN),
  }),
  z.object({ type: z.literal('slot_status'), lot_id: uuid, slot_id: uuid, status: z.string().max(32) }),
  z.object({ type: z.literal('booking_status'), booking_id: uuid, status: z.string().max(32) }),
  z.object({ type: z.literal('error'), code: z.string().max(64) }),
]);

export interface RejectedGroup {
  kind: string;
  id: string;
  code: string;
}

export type ServerMessage =
  | { type: 'ready' }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'subscribed'; groups: Group[]; rejected: RejectedGroup[] }
  | { type: 'unsubscribed'; groups: Group[] }
  | { type: 'availability'; lotId: string; freeSlots: number; totalSlots: number; ts: string }
  | { type: 'slot_status'; lotId: string; slotId: string; status: string }
  | { type: 'booking_status'; bookingId: string; status: string }
  | { type: 'error'; code: string };

/** One inbound frame, or null when it is binary, oversized, not JSON, or not a known message. */
export function parseServerMessage(frame: unknown): ServerMessage | null {
  if (typeof frame !== 'string' || frame.length > MAX_SERVER_MESSAGE_CHARS) return null;
  let json: unknown;
  try {
    json = JSON.parse(frame);
  } catch {
    return null;
  }
  const parsed = messageSchema.safeParse(json);
  if (!parsed.success) return null;
  const m = parsed.data;
  switch (m.type) {
    case 'subscribed':
      return { type: 'subscribed', groups: m.groups, rejected: m.rejected ?? [] };
    case 'availability':
      return { type: 'availability', lotId: m.lot_id, freeSlots: m.free_slots, totalSlots: m.total_slots, ts: m.ts };
    case 'slot_status':
      return { type: 'slot_status', lotId: m.lot_id, slotId: m.slot_id, status: m.status };
    case 'booking_status':
      return { type: 'booking_status', bookingId: m.booking_id, status: m.status };
    default:
      return m;
  }
}

// --- client -> server ----------------------------------------------------------------------------

export interface OutboundMessage {
  payload: string;
  /** Rate-limit tokens the server will charge: one per named group (see rateLimit.ts). */
  cost: number;
}

export const PING_MESSAGE: OutboundMessage = { payload: '{"type":"ping"}', cost: 1 };
export const PONG_MESSAGE: OutboundMessage = { payload: '{"type":"pong"}', cost: 1 };

/** Subscribe / unsubscribe frames for `groups`: at most 50 groups in total, chunked and under 4 KB. */
export function planGroupMessages(type: 'subscribe' | 'unsubscribe', groups: readonly Group[]): OutboundMessage[] {
  const capped = groups.slice(0, MAX_GROUPS);
  const messages: OutboundMessage[] = [];
  for (let i = 0; i < capped.length; i += GROUPS_PER_MESSAGE) {
    const chunk = capped.slice(i, i + GROUPS_PER_MESSAGE).map(({ kind, id }) => ({ kind, id }));
    const payload = JSON.stringify({ type, groups: chunk });
    // Ids are validated ASCII, so the string length is the byte length.
    if (payload.length <= MAX_CLIENT_MESSAGE_BYTES) messages.push({ payload, cost: chunk.length });
  }
  return messages;
}
