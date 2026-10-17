import { describe, expect, it } from 'vitest';

import { canConfirmCancel, describeRefund } from '@/features/booking/refundText';

const nb = (text: string): string => text.replaceAll(' ', String.fromCharCode(160));
const preview = (canCancel: boolean, refundPercent: number, refundAmount: string) => ({
  canCancel,
  refundPercent,
  refundAmount,
});

describe('describeRefund', () => {
  it('full refund shows the amount in the language currency', () => {
    expect(describeRefund(preview(true, 100, '12000.00'), 'CONFIRMED', 'uz')).toEqual({
      key: 'booking.cancel.refundFull',
      params: { amount: nb('12 000 so‘m') },
    });
    expect(describeRefund(preview(true, 100, '12000.00'), 'CONFIRMED', 'en').params).toEqual({ amount: nb('12,000 UZS') });
  });

  it('partial refund shows percent and amount', () => {
    expect(describeRefund(preview(true, 50, '6000.00'), 'CONFIRMED', 'ru')).toEqual({
      key: 'booking.cancel.refundPartial',
      params: { percent: 50, amount: nb('6 000 сум') },
    });
  });

  it('no refund when the policy returns 0 %', () => {
    expect(describeRefund(preview(true, 0, '0.00'), 'CONFIRMED', 'en')).toEqual({
      key: 'booking.cancel.refundNone',
      params: {},
    });
  });

  it('an unpaid hold costs nothing to cancel', () => {
    expect(describeRefund(preview(true, 0, '0.00'), 'PENDING_PAYMENT', 'en')).toEqual({
      key: 'booking.cancel.noPayment',
      params: {},
    });
  });

  it('cannot cancel', () => {
    expect(describeRefund(preview(false, 0, '0.00'), 'ACTIVE', 'en')).toEqual({
      key: 'booking.cancel.notPossible',
      params: {},
    });
  });

  it('a percent with an amount of 0 (nothing paid yet) is not announced as a refund', () => {
    expect(describeRefund(preview(true, 100, '0.00'), 'CONFIRMED', 'en').key).toBe('booking.cancel.refundNone');
  });

  it('a malformed amount degrades to the no-refund text instead of "null"', () => {
    expect(describeRefund(preview(true, 100, 'abc'), 'CONFIRMED', 'en').key).toBe('booking.cancel.refundNone');
  });
});

describe('canConfirmCancel', () => {
  it('needs a fresh, finished preview that allows it (or a failed preview: cancelling stays possible)', () => {
    expect(canConfirmCancel({ isFetching: false, isError: false, data: { canCancel: true, refundPercent: 0, refundAmount: '0.00' } })).toBe(true);
    expect(canConfirmCancel({ isFetching: false, isError: true, data: undefined })).toBe(true);
    expect(canConfirmCancel({ isFetching: false, isError: false, data: { canCancel: false, refundPercent: 0, refundAmount: '0.00' } })).toBe(false);
  });

  it('never while a (re)fetch is running: the shown amount may be from the previous opening', () => {
    expect(canConfirmCancel({ isFetching: true, isError: false, data: { canCancel: true, refundPercent: 100, refundAmount: '1.00' } })).toBe(false);
    expect(canConfirmCancel({ isFetching: true, isError: true, data: undefined })).toBe(false);
  });

  it('never before the first answer', () => {
    expect(canConfirmCancel({ isFetching: false, isError: false, data: undefined })).toBe(false);
  });
});
