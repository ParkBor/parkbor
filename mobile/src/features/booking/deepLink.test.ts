import { describe, expect, it } from 'vitest';

import { resolveBookingParam } from '@/features/booking/deepLink';

const ID = 'e4d0c1de-1111-4222-8333-444455556666';

describe('resolveBookingParam', () => {
  it('accepts a UUID', () => {
    expect(resolveBookingParam(ID)).toEqual({ ok: true, id: ID });
    expect(resolveBookingParam([ID, 'extra'])).toEqual({ ok: true, id: ID });
  });

  it('sends everything else to the bookings list', () => {
    for (const bad of [undefined, '', 'abc', '../me', `${ID}/cancel`, `${ID}?x=1`, [], ['abc'], '00000000-0000-0000-0000-00000000000g']) {
      expect(resolveBookingParam(bad), String(bad)).toEqual({ ok: false });
    }
  });
});
