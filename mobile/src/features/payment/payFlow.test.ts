import { describe, expect, it } from 'vitest';

import { holdLapseAction, payNavigation } from '@/features/payment/payFlow';

describe('payNavigation (what the pay screen does when the booking is no longer payable)', () => {
  it('stays while the booking is payable', () => {
    expect(payNavigation('ready', { hasOpened: true, isUserCancelling: false })).toBe('stay');
  });

  it('before the page was ever shown, a changed booking goes to its detail screen', () => {
    expect(payNavigation('not_pending', { hasOpened: false, isUserCancelling: false })).toBe('detail');
  });

  it('after the page was shown, a changed booking goes to the result screen (it re-checks and explains)', () => {
    expect(payNavigation('not_pending', { hasOpened: true, isUserCancelling: false })).toBe('result');
  });

  it('the user cancelling the booking themselves never lands on "payment not accepted"', () => {
    expect(payNavigation('not_pending', { hasOpened: true, isUserCancelling: true })).toBe('stay');
    expect(payNavigation('not_pending', { hasOpened: false, isUserCancelling: true })).toBe('stay');
  });

  it.each(['hold_over', 'invalid_url', 'no_url'] as const)(
    '%s alone never navigates (the hold is judged by the server, see holdLapseAction)',
    (kind) => {
      expect(payNavigation(kind, { hasOpened: true, isUserCancelling: false })).toBe('stay');
    },
  );
});

describe('holdLapseAction (the device clock is not trusted to end a payment)', () => {
  const NOW = 1_000_000;

  it('keeps the page open when the SERVER hold is still in the future (extended when the provider started)', () => {
    expect(holdLapseAction({ status: 'PENDING_PAYMENT', holdExpiresAtMs: NOW + 1 }, NOW)).toBe('wait');
    expect(holdLapseAction({ status: 'PENDING_PAYMENT', holdExpiresAtMs: NOW + 300_000 }, NOW)).toBe('wait');
  });

  it('closes when the server hold is over too', () => {
    expect(holdLapseAction({ status: 'PENDING_PAYMENT', holdExpiresAtMs: NOW }, NOW)).toBe('close');
    expect(holdLapseAction({ status: 'PENDING_PAYMENT', holdExpiresAtMs: NOW - 5 }, NOW)).toBe('close');
  });

  it.each(['CONFIRMED', 'EXPIRED', 'CANCELLED', 'unknown'] as const)('closes when the server status is %s', (status) => {
    expect(holdLapseAction({ status, holdExpiresAtMs: NOW + 60_000 }, NOW)).toBe('close');
  });

  it('a pending booking with no hold timestamp has nothing to expire', () => {
    expect(holdLapseAction({ status: 'PENDING_PAYMENT', holdExpiresAtMs: null }, NOW)).toBe('wait');
  });
});
