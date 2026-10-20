import { describe, expect, it } from 'vitest';

import {
  BOOKING_STATUSES,
  parseBooking,
  parseBookingPage,
  parseCancelPreview,
  parseQr,
  type Booking,
} from '@/features/booking/bookingSchemas';
import { BOOKING_ID, LOT_ID, rawBooking, rawPage, SLOT_ID, VEHICLE_ID } from '@/features/booking/fixtures';
import { setPaymentSandbox } from '@/features/payment/paymentSandbox';
import { ContractError } from '@/lib/contract';

describe('parseBooking', () => {
  it('maps the contract object to the app model', () => {
    const booking: Booking = parseBooking(rawBooking());
    expect(booking).toEqual({
      id: BOOKING_ID,
      status: 'PENDING_PAYMENT',
      slot: { id: SLOT_ID, code: 'A-12', zone: 'A', floor: 1 },
      parkingLot: { id: LOT_ID, name: 'Chorsu Parking', address: 'Chorsu, Toshkent' },
      vehicle: { id: VEHICLE_ID, plateNumber: '01A123BC', type: 'CAR' },
      startMs: Date.UTC(2026, 9, 15, 9, 0, 0),
      endMs: Date.UTC(2026, 9, 15, 11, 0, 0),
      amount: '12000.00',
      paidAmount: '0.00',
      refundAmount: '0.00',
      holdExpiresAtMs: Date.UTC(2026, 9, 15, 8, 20, 0),
      paymentUrl: null,
      isPaymentUrlInvalid: false,
      paymentProvider: null,
      refundStatus: 'none',
      checkedInAtMs: null,
      checkedOutAtMs: null,
      cancelledAtMs: null,
      createdAtMs: Date.UTC(2026, 9, 15, 8, 10, 0),
    });
  });

  it('accepts every documented status', () => {
    for (const status of BOOKING_STATUSES) expect(parseBooking(rawBooking({ status })).status).toBe(status);
  });

  it('maps an unknown or malformed status to the safe "unknown" view instead of failing', () => {
    expect(parseBooking(rawBooking({ status: 'TELEPORTED' })).status).toBe('unknown');
    expect(parseBooking(rawBooking({ status: 42 })).status).toBe('unknown');
    expect(parseBooking(rawBooking({ status: undefined })).status).toBe('unknown');
  });

  it('keeps null timestamps and parses present ones', () => {
    const booking = parseBooking(rawBooking({ status: 'ACTIVE', checked_in_at: '2026-10-15T14:05:00+05:00', hold_expires_at: null }));
    expect(booking.holdExpiresAtMs).toBeNull();
    expect(booking.checkedInAtMs).toBe(Date.UTC(2026, 9, 15, 9, 5, 0));
  });

  it('keeps a payment_url on the provider allow-list', () => {
    const url = 'https://checkout.paycom.uz/bT01NjQ3';
    const booking = parseBooking(rawBooking({ payment_url: url }));
    expect(booking.paymentUrl).toBe(url);
    expect(booking.isPaymentUrlInvalid).toBe(false);
  });

  it.each([
    'https://pay.example/x',
    'http://checkout.paycom.uz/x',
    'javascript:alert(1)',
    'https://checkout.paycom.uz.evil.com/x',
    'https://checkout.paycom.uz@evil.com/x',
    'https://test.paycom.uz/x',
    12,
    {},
    'null',
  ])('marks the payment_url %j as invalid instead of rejecting the booking', (payment_url) => {
    const booking = parseBooking(rawBooking({ payment_url }));
    expect(booking.paymentUrl).toBeNull();
    expect(booking.isPaymentUrlInvalid).toBe(true);
    expect(booking.id).toBe(BOOKING_ID);
  });

  it('a null, empty or absent payment_url is "no payment page", not an invalid one', () => {
    expect(parseBooking(rawBooking({ payment_url: null })).isPaymentUrlInvalid).toBe(false);
    expect(parseBooking(rawBooking({ payment_url: '' })).isPaymentUrlInvalid).toBe(false);
    const { payment_url: _omitted, ...withoutUrl } = rawBooking();
    const booking = parseBooking(withoutUrl);
    expect(booking.paymentUrl).toBeNull();
    expect(booking.isPaymentUrlInvalid).toBe(false);
  });

  it('accepts the sandbox host only while the sandbox flag is on', () => {
    const url = 'https://test.paycom.uz/bT01';
    expect(parseBooking(rawBooking({ payment_url: url })).paymentUrl).toBeNull();
    setPaymentSandbox(true);
    try {
      expect(parseBooking(rawBooking({ payment_url: url })).paymentUrl).toBe(url);
    } finally {
      setPaymentSandbox(false);
    }
  });

  it('maps payment_provider: known values kept, "" / unknown / absent -> null', () => {
    expect(parseBooking(rawBooking({ payment_provider: 'payme' })).paymentProvider).toBe('payme');
    expect(parseBooking(rawBooking({ payment_provider: 'click' })).paymentProvider).toBe('click');
    expect(parseBooking(rawBooking({ payment_provider: '' })).paymentProvider).toBeNull();
    expect(parseBooking(rawBooking({ payment_provider: 'stripe' })).paymentProvider).toBeNull();
    expect(parseBooking(rawBooking({ payment_provider: 5 })).paymentProvider).toBeNull();
    const { payment_provider: _omitted, ...without } = rawBooking();
    expect(parseBooking(without).paymentProvider).toBeNull();
  });

  it('maps refund_status: known kept, absent -> none, unrecognised -> unknown (never a contract error)', () => {
    for (const status of ['none', 'pending', 'done', 'manual', 'failed']) {
      expect(parseBooking(rawBooking({ refund_status: status })).refundStatus).toBe(status);
    }
    const { refund_status: _omitted, ...without } = rawBooking();
    expect(parseBooking(without).refundStatus).toBe('none');
    expect(parseBooking(rawBooking({ refund_status: 'REFUNDED' })).refundStatus).toBe('unknown');
    expect(parseBooking(rawBooking({ refund_status: null })).refundStatus).toBe('unknown');
    expect(parseBooking(rawBooking({ refund_status: 4 })).refundStatus).toBe('unknown');
  });

  it('rejects naive timestamps, bad money, bad ids and missing objects', () => {
    const bad: Record<string, unknown>[] = [
      { start: '2026-10-15T14:00:00' },
      { end: 'later' },
      { amount: 12000 },
      { amount: '-1.00' },
      { id: 'not-a-uuid' },
      { slot: null },
      { parking_lot: { id: LOT_ID } },
      { vehicle: { id: VEHICLE_ID, plate_number: 5, type: 'CAR' } },
      { hold_expires_at: 'soon' },
    ];
    for (const override of bad) {
      expect(() => parseBooking(rawBooking(override)), JSON.stringify(override)).toThrow(ContractError);
    }
    expect(() => parseBooking(null)).toThrow(ContractError);
    expect(() => parseBooking('x')).toThrow(ContractError);
  });

  it('does not copy unknown fields (nothing unvetted reaches the UI)', () => {
    const booking = parseBooking(rawBooking({ evil: '<script>', admin_note: 'x' }));
    expect(JSON.stringify(booking)).not.toContain('evil');
  });

  it('the error never carries response content', () => {
    try {
      parseBooking(rawBooking({ vehicle: { id: VEHICLE_ID, plate_number: 7, type: 'CAR' }, amount: 'SECRET' }));
    } catch (error) {
      expect(String(error)).not.toContain('SECRET');
      expect(String(error)).not.toContain('01A123BC');
    }
  });
});

describe('parseBookingPage', () => {
  it('parses results and pagination flags', () => {
    const page = parseBookingPage(rawPage([rawBooking()], { count: 31, next: 'http://api/bookings?page=2' }));
    expect(page.results).toHaveLength(1);
    expect(page.count).toBe(31);
    expect(page.hasNext).toBe(true);
    expect(page.skippedCount).toBe(0);
  });

  it('never exposes the server-provided next URL', () => {
    const page = parseBookingPage(rawPage([rawBooking()], { next: 'http://evil.example/steal' }));
    expect(JSON.stringify(page)).not.toContain('evil');
  });

  it('drops a malformed item but keeps the rest', () => {
    const page = parseBookingPage(rawPage([rawBooking(), { id: 'broken' }, rawBooking({ id: LOT_ID })]));
    expect(page.results.map((b) => b.id)).toEqual([BOOKING_ID, LOT_ID]);
    expect(page.skippedCount).toBe(1);
  });

  it('an unknown status is kept (as unknown), not dropped', () => {
    const page = parseBookingPage(rawPage([rawBooking({ status: 'NEW_STATUS' })]));
    expect(page.results[0]?.status).toBe('unknown');
  });

  it('rejects when items arrived but none is valid, or the envelope is broken', () => {
    expect(() => parseBookingPage(rawPage([{ nope: 1 }]))).toThrow(ContractError);
    expect(() => parseBookingPage({ results: 'x' })).toThrow(ContractError);
    expect(() => parseBookingPage(null)).toThrow(ContractError);
  });

  it('an empty page is fine', () => {
    expect(parseBookingPage(rawPage([])).results).toEqual([]);
  });
});

describe('parseQr', () => {
  it('maps token and expiry', () => {
    expect(parseQr({ qr_token: 'abc.def', expires_at: '2026-10-15T18:00:00+05:00' })).toEqual({
      token: 'abc.def',
      expiresAtMs: Date.UTC(2026, 9, 15, 13, 0, 0),
    });
  });

  it('rejects empty, oversized and malformed values', () => {
    expect(() => parseQr({ qr_token: '', expires_at: '2026-10-15T18:00:00+05:00' })).toThrow(ContractError);
    expect(() => parseQr({ qr_token: 'x'.repeat(1025), expires_at: '2026-10-15T18:00:00+05:00' })).toThrow(ContractError);
    expect(() => parseQr({ qr_token: 'x', expires_at: 'tomorrow' })).toThrow(ContractError);
    expect(() => parseQr(undefined)).toThrow(ContractError);
  });

  it('the error never contains the token', () => {
    try {
      parseQr({ qr_token: 'SECRET-TOKEN', expires_at: 'bad' });
    } catch (error) {
      expect(String(error)).not.toContain('SECRET');
    }
  });
});

describe('parseCancelPreview', () => {
  it('maps the preview', () => {
    expect(parseCancelPreview({ can_cancel: true, refund_percent: 50, refund_amount: '6000.00' })).toEqual({
      canCancel: true,
      refundPercent: 50,
      refundAmount: '6000.00',
    });
  });

  it('rejects percent outside 0..100 and non-string money', () => {
    expect(() => parseCancelPreview({ can_cancel: true, refund_percent: 150, refund_amount: '1.00' })).toThrow(ContractError);
    expect(() => parseCancelPreview({ can_cancel: true, refund_percent: 10, refund_amount: 5 })).toThrow(ContractError);
    expect(() => parseCancelPreview({ can_cancel: 'yes', refund_percent: 10, refund_amount: '5.00' })).toThrow(ContractError);
  });
});

describe('walk-in bookings without a registered vehicle', () => {
  it.each([
    ['null id and type', { id: null, plate_number: 'A123', type: null }],
    ['null id/type and no plate', { id: null, type: null }],
    ['null plate', { id: null, plate_number: null, type: null }],
    ['an empty object', {}],
    ['no vehicle at all', null],
  ])('parses %s', (_name, vehicle) => {
    const booking = parseBooking(rawBooking({ vehicle }));
    expect(booking.vehicle.id).toBeNull();
    expect(booking.vehicle.type).toBeNull();
    expect(typeof booking.vehicle.plateNumber).toBe('string');
  });

  it('keeps the plate when the walk-in has one', () => {
    expect(parseBooking(rawBooking({ vehicle: { id: null, plate_number: '01A123BC', type: null } })).vehicle).toEqual({
      id: null,
      plateNumber: '01A123BC',
      type: null,
    });
  });

  it('an absent vehicle gives an empty plate (screens hide the row)', () => {
    expect(parseBooking(rawBooking({ vehicle: null })).vehicle.plateNumber).toBe('');
  });

  it('a page with a walk-in among normal bookings still parses completely', () => {
    const page = parseBookingPage(rawPage([rawBooking(), rawBooking({ id: 'f1a0c1de-1111-4222-8333-444455556666', vehicle: { id: null, type: null } })]));
    expect(page.results).toHaveLength(2);
    expect(page.skippedCount).toBe(0);
  });

  it('a malformed vehicle id (not null, not a uuid) is still refused', () => {
    expect(() => parseBooking(rawBooking({ vehicle: { id: 'nope', plate_number: 'A1', type: 'CAR' } }))).toThrow(ContractError);
  });
});
