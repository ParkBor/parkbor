import { describe, expect, it } from 'vitest';

import {
  bookingIdFromNotificationData,
  bookingIdFromUrl,
  createResponseDeduper,
  PENDING_TAP_TTL_MS,
  decidePendingTap,
} from '@/features/push/notificationLink';

const ID = 'e4d0c1de-1111-4222-8333-444455556666';

describe('bookingIdFromUrl (push data.url is untrusted)', () => {
  it('accepts exactly habi://booking/<uuid>', () => {
    expect(bookingIdFromUrl(`habi://booking/${ID}`)).toBe(ID);
    expect(bookingIdFromUrl(`habi://booking/${ID}/`)).toBe(ID);
    expect(bookingIdFromUrl(`HABI://booking/${ID}`)).toBe(ID);
  });

  it.each([
    ['another scheme', `https://booking/${ID}`],
    ['a web universal link', `https://habi.uz/b/${ID}`],
    ['javascript scheme', `javascript:alert(1)//${ID}`],
    ['another host', `habi://payment/${ID}`],
    ['another host that merely contains booking', `habi://evil.com/booking/${ID}`],
    ['userinfo smuggling', `habi://booking@evil.com/${ID}`],
    ['path suffix', `habi://booking/${ID}/cancel`],
    ['query', `habi://booking/${ID}?next=/operator`],
    ['fragment', `habi://booking/${ID}#x`],
    ['traversal', 'habi://booking/../me'],
    ['not a uuid', 'habi://booking/123'],
    ['empty id', 'habi://booking/'],
    ['no id', 'habi://booking'],
    ['extra leading space', ` habi://booking/${ID}`],
    ['newline', `habi://booking/${ID}\n`],
    ['encoded slash', `habi://booking/${ID}%2Fcancel`],
    ['huge string', `habi://booking/${ID}${'a'.repeat(5000)}`],
    ['empty', ''],
  ])('rejects %s', (_name, url) => {
    expect(bookingIdFromUrl(url)).toBeNull();
  });

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 5, {}, [], [`habi://booking/${ID}`]]) {
      expect(bookingIdFromUrl(value)).toBeNull();
    }
  });
});

describe('bookingIdFromNotificationData', () => {
  it('reads data.url', () => {
    expect(bookingIdFromNotificationData({ url: `habi://booking/${ID}` })).toBe(ID);
  });

  it('ignores everything else, including a bare booking_id field', () => {
    expect(bookingIdFromNotificationData({ booking_id: ID })).toBeNull();
    expect(bookingIdFromNotificationData(null)).toBeNull();
    expect(bookingIdFromNotificationData('habi://booking/' + ID)).toBeNull();
    expect(bookingIdFromNotificationData({ url: 5 })).toBeNull();
  });
});

describe('decidePendingTap', () => {
  const T0 = 1_000_000;
  const tap = { id: ID, atMs: T0 };
  const ready = { isAuthenticated: true, isOnboardingDone: true, isGuardSettled: true };

  it('opens once the user is signed in, past onboarding and the guard has settled', () => {
    expect(decidePendingTap(tap, ready, T0 + 1000)).toEqual({ type: 'open', id: ID });
  });

  it('waits while signed out, in onboarding, or before the auth guard has settled (cold start race)', () => {
    expect(decidePendingTap(tap, { ...ready, isAuthenticated: false }, T0)).toEqual({ type: 'wait' });
    expect(decidePendingTap(tap, { ...ready, isOnboardingDone: false }, T0)).toEqual({ type: 'wait' });
    expect(decidePendingTap(tap, { ...ready, isGuardSettled: false }, T0)).toEqual({ type: 'wait' });
  });

  it('drops a tap that waited longer than five minutes, or has nothing pending', () => {
    expect(decidePendingTap(tap, ready, T0 + PENDING_TAP_TTL_MS)).toEqual({ type: 'open', id: ID });
    expect(decidePendingTap(tap, ready, T0 + PENDING_TAP_TTL_MS + 1)).toEqual({ type: 'drop' });
    expect(decidePendingTap(tap, { ...ready, isGuardSettled: false }, T0 + PENDING_TAP_TTL_MS + 1)).toEqual({ type: 'drop' });
    expect(decidePendingTap(null, ready, T0)).toEqual({ type: 'drop' });
  });

  it('drops a tap stamped in the future (clock went backwards)', () => {
    expect(decidePendingTap({ id: ID, atMs: T0 + 10 }, ready, T0)).toEqual({ type: 'drop' });
  });
});

describe('createResponseDeduper', () => {
  it('handles a notification response only once (cold start + listener both deliver it)', () => {
    const dedupe = createResponseDeduper();
    expect(dedupe.isNew('n1')).toBe(true);
    expect(dedupe.isNew('n1')).toBe(false);
    expect(dedupe.isNew('n2')).toBe(true);
  });

  it('stays bounded', () => {
    const dedupe = createResponseDeduper(2);
    dedupe.isNew('a');
    dedupe.isNew('b');
    dedupe.isNew('c');
    expect(dedupe.isNew('a')).toBe(true);
  });

  it('treats a missing identifier as new each time', () => {
    const dedupe = createResponseDeduper();
    expect(dedupe.isNew(undefined)).toBe(true);
    expect(dedupe.isNew(undefined)).toBe(true);
  });
});
