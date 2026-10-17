import type { BookingStatus, CancelPreview } from '@/features/booking/bookingSchemas';
import { formatPrice } from '@/features/map/format';
import type { Language } from '@/lib/types';

export interface RefundText {
  key:
    | 'booking.cancel.refundFull'
    | 'booking.cancel.refundPartial'
    | 'booking.cancel.refundNone'
    | 'booking.cancel.noPayment'
    | 'booking.cancel.notPossible';
  params: Record<string, string | number>;
}

const FULL_REFUND_PERCENT = 100;
const ZERO_AMOUNT = /^0+(?:\.0+)?$/;

/**
 * What the user is told before confirming a cancellation. Amounts come from the server's
 * cancel-preview (percent of what was actually PAID); the client never recomputes money.
 */
export function describeRefund(preview: CancelPreview, status: BookingStatus, lang: Language): RefundText {
  if (!preview.canCancel) return { key: 'booking.cancel.notPossible', params: {} };
  const amount = formatPrice(preview.refundAmount, lang);
  const hasRefund = amount !== null && !ZERO_AMOUNT.test(preview.refundAmount) && preview.refundPercent > 0;
  if (!hasRefund) {
    return status === 'PENDING_PAYMENT'
      ? { key: 'booking.cancel.noPayment', params: {} }
      : { key: 'booking.cancel.refundNone', params: {} };
  }
  if (preview.refundPercent >= FULL_REFUND_PERCENT) return { key: 'booking.cancel.refundFull', params: { amount } };
  return { key: 'booking.cancel.refundPartial', params: { percent: preview.refundPercent, amount } };
}

export interface CancelPreviewState {
  isFetching: boolean;
  isError: boolean;
  data: CancelPreview | undefined;
}

/**
 * Confirm is possible only on a finished, fresh preview that allows it, or when the preview failed
 * (cancelling stays possible, the amount is unknown). Never while a refetch runs: the figure on
 * screen could belong to the previous time the dialog was open.
 */
export function canConfirmCancel(state: CancelPreviewState): boolean {
  if (state.isFetching) return false;
  return state.isError || state.data?.canCancel === true;
}
