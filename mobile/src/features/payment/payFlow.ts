import type { BookingStatus } from '@/features/booking/bookingSchemas';
import type { PayAvailability } from '@/features/payment/payAvailability';

export type PayNavTarget = 'stay' | 'detail' | 'result';

export interface PayNavContext {
  /** The provider page was shown at least once on this screen. */
  hasOpened: boolean;
  /** The user opened the cancel dialog: the status change that follows is their own doing. */
  isUserCancelling: boolean;
}

/**
 * Where the pay screen goes when the booking stops being payable. A hold running out is NOT decided
 * here (the device clock is not trusted): see `holdLapseAction`.
 */
export function payNavigation(kind: PayAvailability['kind'], context: PayNavContext): PayNavTarget {
  if (context.isUserCancelling || kind !== 'not_pending') return 'stay';
  return context.hasOpened ? 'result' : 'detail';
}

/**
 * The local timer says the hold is over. Only a fresh SERVER booking may close the payment page:
 * the server extends the hold (up to 5 minutes) when the provider transaction starts.
 */
export function holdLapseAction(
  booking: { status: BookingStatus; holdExpiresAtMs: number | null },
  serverNowMs: number,
): 'wait' | 'close' {
  if (booking.status !== 'PENDING_PAYMENT') return 'close';
  if (booking.holdExpiresAtMs === null) return 'wait';
  return booking.holdExpiresAtMs > serverNowMs ? 'wait' : 'close';
}
