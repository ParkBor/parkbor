/**
 * `refund_amount` is the policy PROMISE; `refund_status` is what actually happened to the money
 * (ARCHITECTURE 9.5). The UI says "refunded" only for `done`.
 */
export const REFUND_STATUSES = ['none', 'pending', 'done', 'manual', 'failed', 'unknown'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

const KNOWN_STATUSES = REFUND_STATUSES.filter((status) => status !== 'unknown');
const ZERO_AMOUNT = /^0+(?:\.0+)?$/;

/** Absent field (older server) = `none`; a value this app does not know = `unknown` (safe, neutral text). */
export function parseRefundStatus(value: unknown): RefundStatus {
  if (value === undefined) return 'none';
  return KNOWN_STATUSES.find((status) => status === value) ?? 'unknown';
}

export type RefundTone = 'success' | 'warning' | 'error' | 'muted';

export interface RefundView {
  /** i18n key of the explanation. */
  textKey: string;
  tone: RefundTone;
  /** Label of the amount row: "refunded" only when the money really came back, otherwise "due (promise)". */
  amountLabelKey: 'booking.detail.refunded' | 'booking.detail.refundDue';
  /** Whether there is a non-zero amount to show. */
  hasAmount: boolean;
}

const TONES: Readonly<Record<Exclude<RefundStatus, 'none'>, RefundTone>> = {
  pending: 'warning',
  done: 'success',
  manual: 'warning',
  failed: 'error',
  unknown: 'muted',
};

/** null = nothing to say (no refund promised and none started). */
export function refundView(status: RefundStatus, refundAmount: string): RefundView | null {
  const hasAmount = !ZERO_AMOUNT.test(refundAmount);
  if (status === 'none') {
    return hasAmount
      ? { textKey: 'booking.refund.promised', tone: 'muted', amountLabelKey: 'booking.detail.refundDue', hasAmount }
      : null;
  }
  return {
    textKey: `booking.refund.${status}`,
    tone: TONES[status],
    amountLabelKey: status === 'done' ? 'booking.detail.refunded' : 'booking.detail.refundDue',
    hasAmount,
  };
}
