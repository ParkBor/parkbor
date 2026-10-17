import { z } from 'zod';

import type { SlotType } from '@/features/map/schemas';
import { ContractError, instantSchema, moneySchema, uuidSchema } from '@/lib/contract';

// Operator API answers (ARCHITECTURE 9.2). Strict where the app acts on a field, lenient where an
// unknown enum value can safely degrade to 'unknown' (which the UI shows as a red/neutral state,
// never as a success). Errors carry the contract name only - never response content.

export type LotStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_REVIEW' | 'unknown';
export type SlotStatus = 'FREE' | 'RESERVED' | 'OCCUPIED' | 'OUT_OF_SERVICE' | 'unknown';
export type BookingKind = 'ONLINE' | 'WALK_IN' | 'unknown';
export type OverstayStatus = 'none' | 'due' | 'collected' | 'waived' | 'unknown';

function oneOf<T extends string>(values: readonly T[]) {
  const known: ReadonlySet<string> = new Set(values);
  return z.unknown().transform((value): T | 'unknown' => (typeof value === 'string' && known.has(value) ? (value as T) : 'unknown'));
}

const lotStatus = oneOf<Exclude<LotStatus, 'unknown'>>(['ACTIVE', 'SUSPENDED', 'PENDING_REVIEW']);
const slotStatus = oneOf<Exclude<SlotStatus, 'unknown'>>(['FREE', 'RESERVED', 'OCCUPIED', 'OUT_OF_SERVICE']);
const slotType = oneOf<SlotType>(['STANDARD', 'EV', 'DISABLED', 'LARGE']);
const bookingKind = oneOf<Exclude<BookingKind, 'unknown'>>(['ONLINE', 'WALK_IN']);
const overstayStatus = oneOf<Exclude<OverstayStatus, 'unknown'>>(['none', 'due', 'collected', 'waived']);
/** Absent or not a boolean -> false (older servers). */
const looseBool = z.unknown().transform((value) => value === true);

function parseWith<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ContractError(what);
  return parsed.data;
}

// --- lots ----------------------------------------------------------------------------------------

const lotSchema = z
  .object({
    id: uuidSchema,
    name: z.string().max(200),
    address: z.string().max(400).optional(),
    status: lotStatus,
    total_slots: z.number().int().nonnegative().optional(),
    free_slots: z.number().int().nonnegative().optional(),
    require_plate_on_checkin: looseBool.optional(),
  })
  .transform((raw) => ({
    id: raw.id,
    name: raw.name,
    address: raw.address ?? '',
    status: raw.status,
    totalSlots: raw.total_slots ?? 0,
    freeSlots: raw.free_slots ?? 0,
    requirePlateOnCheckin: raw.require_plate_on_checkin ?? false,
  }));

export type OperatorLot = z.infer<typeof lotSchema>;

export interface LotPage {
  results: OperatorLot[];
  hasNext: boolean;
}

const lotPageSchema = z.object({
  results: z.array(lotSchema),
  next: z.string().nullable().optional(),
});

export function parseLotPage(data: unknown): LotPage {
  const page = parseWith(lotPageSchema, data, 'operator lots');
  return { results: page.results, hasNext: typeof page.next === 'string' && page.next.length > 0 };
}

// --- slot map ------------------------------------------------------------------------------------

const mapBookingSchema = z
  .object({
    id: uuidSchema,
    status: z.string().max(32),
    kind: bookingKind,
    plate_number: z.string().max(32).nullable(),
    start: instantSchema,
    end: instantSchema,
  })
  .transform((raw) => ({ id: raw.id, status: raw.status, kind: raw.kind, plate: raw.plate_number, startMs: raw.start, endMs: raw.end }));

export type MapBooking = z.infer<typeof mapBookingSchema>;

const mapSlotSchema = z
  .object({
    id: uuidSchema,
    code: z.string().max(32),
    zone: z.string().max(64),
    floor: z.number().int(),
    type: slotType,
    status: slotStatus,
    current_booking: mapBookingSchema.nullable().optional(),
    next_booking: mapBookingSchema.nullable().optional(),
  })
  .transform((raw) => ({
    id: raw.id,
    code: raw.code,
    zone: raw.zone,
    floor: raw.floor,
    type: raw.type,
    status: raw.status,
    current: raw.current_booking ?? null,
    next: raw.next_booking ?? null,
  }));

export type MapSlot = z.infer<typeof mapSlotSchema>;

const slotMapSchema = z.object({
  parking_lot: lotSchema,
  slots: z.array(mapSlotSchema),
  truncated: z.boolean(),
});

export interface SlotMap {
  lot: OperatorLot;
  slots: MapSlot[];
  truncated: boolean;
}

export function parseSlotMap(data: unknown): SlotMap {
  const raw = parseWith(slotMapSchema, data, 'slot map');
  return { lot: raw.parking_lot, slots: raw.slots, truncated: raw.truncated };
}

// --- gate bookings -------------------------------------------------------------------------------
// After a 2xx the server HAS acted (a car was admitted / released). A surprise in a field that only
// decorates the card must not turn that into an error, so display-only fields are soft (`catch`).
// Hard: booking id, plate, slot id + code (what the operator compares with the car), `result`,
// `allowed` and, for exit, `to_collect` (the cash the operator is asked to take).

const softMoney = moneySchema.nullable().catch(null).optional();
const softInstant = instantSchema.nullable().catch(null);

const gateBookingSchema = z
  .object({
    id: uuidSchema,
    status: z.string().max(32).catch(''),
    kind: bookingKind,
    plate_number: z.string().min(1).max(32),
    slot: z.object({
      id: uuidSchema,
      code: z.string().min(1).max(32),
      zone: z.string().max(64).catch(''),
      floor: z.number().int().catch(0),
    }),
    start: softInstant,
    end: softInstant,
    amount: softMoney,
    paid_amount: softMoney,
    overstay_amount: softMoney,
    overstay_needs_review: looseBool.optional(),
  })
  .transform((raw) => ({
    id: raw.id,
    status: raw.status,
    kind: raw.kind,
    plate: raw.plate_number,
    slot: { id: raw.slot.id, code: raw.slot.code, zone: raw.slot.zone, floor: raw.slot.floor },
    startMs: raw.start,
    endMs: raw.end,
    amount: raw.amount ?? null,
    paidAmount: raw.paid_amount ?? null,
    overstayAmount: raw.overstay_amount ?? null,
    /** The backend flags a capped / unpriced charge on the BOOKING (`overstay_needs_review`). */
    needsReview: raw.overstay_needs_review ?? false,
  }));

export type GateBooking = z.infer<typeof gateBookingSchema>;

// --- check-in ------------------------------------------------------------------------------------

const checkInSchema = z
  .object({
    allowed: z.boolean(),
    result: oneOf(['checked_in', 'already_checked_in'] as const),
    booking: gateBookingSchema,
    next: z.object({ checkout_by: softInstant }).nullable().catch(null).optional(),
  })
  .transform((raw) => ({
    allowed: raw.allowed,
    result: raw.result,
    booking: raw.booking,
    checkoutByMs: raw.next?.checkout_by ?? null,
  }));

export type CheckInResult = z.infer<typeof checkInSchema>;

export function parseCheckIn(data: unknown): CheckInResult {
  return parseWith(checkInSchema, data, 'check-in');
}

// --- check-out -----------------------------------------------------------------------------------

const overstaySchema = z
  .object({
    minutes: z.number().int().nonnegative().catch(0),
    amount: moneySchema.catch('0.00'),
    status: overstayStatus,
    needs_review: looseBool.optional(),
  })
  .transform((raw) => ({ minutes: raw.minutes, amount: raw.amount, status: raw.status, needsReview: raw.needs_review ?? false }));

const checkOutSchema = z
  .object({
    result: oneOf(['completed', 'already_completed'] as const),
    allowed: z.boolean().optional(),
    booking: gateBookingSchema,
    actual_minutes: z.number().int().nonnegative().catch(0),
    overstay: overstaySchema.optional().catch(undefined),
    to_collect: moneySchema,
  })
  .transform((raw) => {
    const overstay = raw.overstay ?? { minutes: 0, amount: '0.00', status: 'unknown' as const, needsReview: false };
    return {
      result: raw.result,
      // Only a real completion is green. An old server sends no `allowed`: derive it from `result`.
      // A repeated exit QR is never green, whatever the flag says.
      allowed: raw.result === 'completed' && (raw.allowed ?? true),
      booking: raw.booking,
      actualMinutes: raw.actual_minutes,
      // Either place counts: the booking flag (what the backend sends) or overstay.needs_review.
      overstay: { ...overstay, needsReview: overstay.needsReview || raw.booking.needsReview },
      toCollect: raw.to_collect,
    };
  });

export type CheckOutResult = z.infer<typeof checkOutSchema>;

export function parseCheckOut(data: unknown): CheckOutResult {
  return parseWith(checkOutSchema, data, 'check-out');
}

// --- walk-in, slot patch, invite -----------------------------------------------------------------

const walkInSchema = z
  .object({ result: oneOf(['registered'] as const), booking: gateBookingSchema, valid_until: instantSchema })
  .transform((raw) => ({ result: raw.result, booking: raw.booking, validUntilMs: raw.valid_until }));

export type WalkInResult = z.infer<typeof walkInSchema>;

export function parseWalkIn(data: unknown): WalkInResult {
  return parseWith(walkInSchema, data, 'walk-in');
}

const slotPatchedSchema = z
  .object({
    id: uuidSchema,
    code: z.string().max(32),
    status: slotStatus,
    affected_bookings: z.number().int().nonnegative(),
  })
  .transform((raw) => ({ id: raw.id, code: raw.code, status: raw.status, affectedBookings: raw.affected_bookings }));

export type SlotPatched = z.infer<typeof slotPatchedSchema>;

export function parseSlotPatched(data: unknown): SlotPatched {
  return parseWith(slotPatchedSchema, data, 'slot update');
}

const inviteAcceptedSchema = z
  .object({ parking_lot: z.object({ id: uuidSchema, name: z.string().max(200) }) })
  .transform((raw) => ({ lotId: raw.parking_lot.id, lotName: raw.parking_lot.name }));

export type InviteAccepted = z.infer<typeof inviteAcceptedSchema>;

export function parseInviteAccepted(data: unknown): InviteAccepted {
  return parseWith(inviteAcceptedSchema, data, 'operator invite');
}
