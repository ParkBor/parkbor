import { afterEach, describe, expect, it } from 'vitest';

import { clearLastPayment, getLastPaymentBookingId, rememberPaymentBooking } from '@/features/payment/lastPayment';

const ID = 'e4d0c1de-1111-4222-8333-444455556666';

afterEach(() => clearLastPayment());

describe('lastPayment (memory only)', () => {
  it('is empty at start', () => {
    expect(getLastPaymentBookingId()).toBeNull();
  });

  it('remembers the booking whose payment page was opened', () => {
    rememberPaymentBooking(ID);
    expect(getLastPaymentBookingId()).toBe(ID);
  });

  it('refuses anything that is not a UUID', () => {
    rememberPaymentBooking(ID);
    rememberPaymentBooking('../../etc');
    expect(getLastPaymentBookingId()).toBe(ID);
  });

  it('clear() forgets it', () => {
    rememberPaymentBooking(ID);
    clearLastPayment();
    expect(getLastPaymentBookingId()).toBeNull();
  });
});
