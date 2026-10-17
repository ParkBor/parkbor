import type { BookingStatus } from '@/features/booking/bookingSchemas';
import { isAllowedPaymentUrl } from '@/features/payment/paymentUrl';

export interface PayableBooking {
  status: BookingStatus;
  paymentUrl: string | null;
  /** The server sent a payment_url this app refused (not https / not on the provider allow-list). */
  isPaymentUrlInvalid: boolean;
  holdExpiresAtMs: number | null;
}

export type PayAvailability =
  | { kind: 'ready'; url: string }
  | { kind: 'not_pending' }
  | { kind: 'hold_over' }
  | { kind: 'invalid_url' }
  | { kind: 'no_url' };

/**
 * May the payment page be opened now? `nowMs` is the server-corrected clock. The URL is checked
 * again here, at the moment of opening (it was already filtered when the booking was parsed).
 */
export function payAvailability(booking: PayableBooking, nowMs: number): PayAvailability {
  if (booking.status !== 'PENDING_PAYMENT') return { kind: 'not_pending' };
  if (booking.holdExpiresAtMs !== null && booking.holdExpiresAtMs <= nowMs) return { kind: 'hold_over' };
  if (booking.paymentUrl === null) return { kind: booking.isPaymentUrlInvalid ? 'invalid_url' : 'no_url' };
  if (!isAllowedPaymentUrl(booking.paymentUrl)) return { kind: 'invalid_url' };
  return { kind: 'ready', url: booking.paymentUrl };
}
