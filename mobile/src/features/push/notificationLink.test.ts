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
  it('accepts exactly parkbor://booking/<uuid>', () => {
    expect(bookingIdFromUrl(`parkbor://booking/${ID}`)).toBe(ID);
    expect(bookingIdFromUrl(`parkbor://booking/${ID}/`)).toBe(ID);
    expect(bookingIdFromUrl(`PARKBOR://booking/${ID}`)).toBe(ID);
  });

  it.each([
    ['another scheme', `https://booking/${ID}`],
    ['a web universal link', `https://parkbor.uz/b/${ID}`],
    ['javascript scheme', `javascript:alert(1)//${ID}`],
    ['the retired habi:// scheme', `habi://booking/${ID}`],
    ['another host', `parkbor://payment/${ID}`],
    ['another host that merely contains booking', `parkbor://evil.com/booking/${ID}`],
    ['userinfo smuggling', `parkbor://booking@evil.com/${ID}`],
    ['path suffix', `parkbor://booking/${ID}/cancel`],
    ['query', `parkbor://booking/${ID}?next=/operator`],
    ['fragment', `parkbor://booking/${ID}#x`],
    ['traversal', 'parkbor://booking/../me'],
    ['not a uuid', 'parkbor://booking/123'],
    ['empty id', 'parkbor://booking/'],
    ['no id', 'parkbor://booking'],
    ['extra leading space', ` parkbor://booking/${ID}`],
    ['newline', `parkbor://booking/${ID}\n`],
    ['encoded slash', `parkbor://booking/${ID}%2Fcancel`],
    ['huge string', `parkbor://booking/${ID}${'a'.repeat(5000)}`],
    ['empty', ''],
  ])('rejects %s', (_name, url) => {
    expect(bookingIdFromUrl(url)).toBeNull();
  });

  it('rejects non-strings', () => {
    for (const value of [undefined, null, 5, {}, [], [`parkbor://booking/${ID}`]]) {
      expect(bookingIdFromUrl(value)).toBeNull();
    }
  });
});

describe('bookingIdFromNotificationData', () => {
  it('reads data.url', () => {
    expect(bookingIdFromNotificationData({ url: `parkbor://booking/${ID}` })).toBe(ID);
  });

  it('ignores everything else, including a bare booking_id field', () => {
    expect(bookingIdFromNotificationData({ booking_id: ID })).toBeNull();
    expect(bookingIdFromNotificationData(null)).toBeNull();
    expect(bookingIdFromNotificationData('parkbor://booking/' + ID)).toBeNull();
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
