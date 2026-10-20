import { z } from 'zod';

import { isAllowedPaymentUrl } from '@/features/payment/paymentUrl';
import { parsePaymentProvider, type PaymentProvider } from '@/features/payment/providerChoice';
import { parseRefundStatus, type RefundStatus } from '@/features/payment/refundView';
import { ContractError, instantSchema, moneySchema, uuidSchema } from '@/lib/contract';

export const BOOKING_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'ACTIVE',
  'OVERSTAY',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'NO_SHOW',
] as const;

export type KnownBookingStatus = (typeof BOOKING_STATUSES)[number];
/** A status this app version does not know renders as the neutral "unknown" view. */
export type BookingStatus = KnownBookingStatus | 'unknown';

/** Largest QR token the server signs (ARCHITECTURE 10.8: <= 1024). */
export const MAX_QR_TOKEN_LENGTH = 1024;

const knownStatuses: ReadonlySet<string> = new Set(BOOKING_STATUSES);

const statusSchema = z
  .unknown()
  .transform((value): BookingStatus => (typeof value === 'string' && knownStatuses.has(value) ? (value as KnownBookingStatus) : 'unknown'));

const nullableInstant = instantSchema.nullable();
/**
 * `payment_url` is checked against the provider allow-list (https, exact host, no userinfo/port; see
 * payment/paymentUrl). A URL that fails is NOT a contract error: the booking stays usable, the URL is
 * dropped and flagged, and the UI says "payment is not available" instead of opening it.
 */
const paymentUrl = z.unknown().optional().transform((value): { url: string | null; isInvalid: boolean } => {
  if (value === null || value === undefined || value === '') return { url: null, isInvalid: false };
  return isAllowedPaymentUrl(value) ? { url: value, isInvalid: false } : { url: null, isInvalid: true };
});
const paymentProvider = z.unknown().optional().transform((value): PaymentProvider | null => parsePaymentProvider(value));
const refundStatus = z.unknown().optional().transform((value): RefundStatus => parseRefundStatus(value));

const bookingSchema = z.object({
  id: uuidSchema,
  status: statusSchema,
  slot: z.object({
    id: uuidSchema,
    code: z.string().max(32),
    zone: z.string().max(64),
    floor: z.number().int(),
  }),
  parking_lot: z.object({
    id: uuidSchema,
    name: z.string().max(200),
    address: z.string().max(400),
  }),
  // A walk-in booking may have no registered vehicle: {id: null, type: null} (plate may be missing too).
  vehicle: z
    .object({
      id: uuidSchema.nullable().optional(),
      plate_number: z.string().max(32).nullable().optional(),
      type: z.string().max(32).nullable().optional(),
    })
    .nullable()
    .optional(),
  start: instantSchema,
  end: instantSchema,
  amount: moneySchema,
  paid_amount: moneySchema,
  refund_amount: moneySchema,
  hold_expires_at: nullableInstant,
  payment_url: paymentUrl,
  payment_provider: paymentProvider,
  refund_status: refundStatus,
  checked_in_at: nullableInstant,
  checked_out_at: nullableInstant,
  cancelled_at: nullableInstant,
  created_at: instantSchema,
});

export interface Booking {
  id: string;
  status: BookingStatus;
  slot: { id: string; code: string; zone: string; floor: number };
  parkingLot: { id: string; name: string; address: string };
  /** `id` / `type` are null for a walk-in without a registered vehicle; `plateNumber` is '' when unknown. */
  vehicle: { id: string | null; plateNumber: string; type: string | null };
  startMs: number;
  endMs: number;
  /** Decimal strings; money is never converted to a float. */
  amount: string;
  paidAmount: string;
  refundAmount: string;
  holdExpiresAtMs: number | null;
  /** Payment page URL; non-null only when it passed the provider allow-list (payment/paymentUrl). */
  paymentUrl: string | null;
  /** The server sent a payment_url that was refused (not https / unknown host): show "payment unavailable". */
  isPaymentUrlInvalid: boolean;
  /** Checkout chosen at creation; null for "" (older bookings) or an unknown value. */
  paymentProvider: PaymentProvider | null;
  /** What actually happened to the promised refund (`refundAmount` is only the promise). */
  refundStatus: RefundStatus;
  checkedInAtMs: number | null;
  checkedOutAtMs: number | null;
  cancelledAtMs: number | null;
  createdAtMs: number;
}

function toBooking(raw: z.infer<typeof bookingSchema>): Booking {
  return {
    id: raw.id,
    status: raw.status,
    slot: { id: raw.slot.id, code: raw.slot.code, zone: raw.slot.zone, floor: raw.slot.floor },
    parkingLot: { id: raw.parking_lot.id, name: raw.parking_lot.name, address: raw.parking_lot.address },
    vehicle: { id: raw.vehicle?.id ?? null, plateNumber: raw.vehicle?.plate_number ?? '', type: raw.vehicle?.type ?? null },
    startMs: raw.start,
    endMs: raw.end,
    amount: raw.amount,
    paidAmount: raw.paid_amount,
    refundAmount: raw.refund_amount,
    holdExpiresAtMs: raw.hold_expires_at,
    paymentUrl: raw.payment_url.url,
    isPaymentUrlInvalid: raw.payment_url.isInvalid,
    paymentProvider: raw.payment_provider,
    refundStatus: raw.refund_status,
    checkedInAtMs: raw.checked_in_at,
    checkedOutAtMs: raw.checked_out_at,
    cancelledAtMs: raw.cancelled_at,
    createdAtMs: raw.created_at,
  };
}

/** Strict: an object that breaks the contract is rejected whole. Errors carry no response content. */
export function parseBooking(data: unknown): Booking {
  const parsed = bookingSchema.safeParse(data);
  if (!parsed.success) throw new ContractError('booking');
  return toBooking(parsed.data);
}

export interface BookingPage {
  results: Booking[];
  count: number;
  /** Whether another page exists. The server's `next` URL is deliberately NOT kept or followed. */
  hasNext: boolean;
  /** Items dropped for not matching the contract. */
  skippedCount: number;
}

const pageSchema = z.object({
  count: z.number().int().min(0),
  next: z.string().nullable(),
  results: z.array(z.unknown()),
});

/** Items are validated one by one: one malformed booking does not blank the whole list. */
export function parseBookingPage(data: unknown): BookingPage {
  const envelope = pageSchema.safeParse(data);
  if (!envelope.success) throw new ContractError('booking list');
  const results: Booking[] = [];
  for (const item of envelope.data.results) {
    const parsed = bookingSchema.safeParse(item);
    if (parsed.success) results.push(toBooking(parsed.data));
  }
  if (envelope.data.results.length > 0 && results.length === 0) throw new ContractError('booking list');
  return {
    results,
    count: envelope.data.count,
    hasNext: envelope.data.next !== null,
    skippedCount: envelope.data.results.length - results.length,
  };
}

export interface QrPayload {
  token: string;
  expiresAtMs: number;
}

const qrSchema = z.object({
  qr_token: z.string().min(1).max(MAX_QR_TOKEN_LENGTH),
  expires_at: instantSchema,
});

/** Never put the token in an error or a log line. */
export function parseQr(data: unknown): QrPayload {
  const parsed = qrSchema.safeParse(data);
  if (!parsed.success) throw new ContractError('qr');
  return { token: parsed.data.qr_token, expiresAtMs: parsed.data.expires_at };
}

export interface CancelPreview {
  canCancel: boolean;
  refundPercent: number;
  refundAmount: string;
}

const cancelPreviewSchema = z.object({
  can_cancel: z.boolean(),
  refund_percent: z.number().int().min(0).max(100),
  refund_amount: moneySchema,
});

export function parseCancelPreview(data: unknown): CancelPreview {
  const parsed = cancelPreviewSchema.safeParse(data);
  if (!parsed.success) throw new ContractError('cancel preview');
  return {
    canCancel: parsed.data.can_cancel,
    refundPercent: parsed.data.refund_percent,
    refundAmount: parsed.data.refund_amount,
  };
}
