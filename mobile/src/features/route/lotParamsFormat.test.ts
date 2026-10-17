import { describe, expect, it } from 'vitest';

import { formatCoordParam, parseLatLngParams, resolveLot } from '@/features/route/lotParams';

const ID = '3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b';

describe('formatCoordParam', () => {
  it('rounds to 6 decimals in plain fixed notation', () => {
    expect(formatCoordParam(41.326512345678)).toBe('41.326512');
    expect(formatCoordParam(-0.5)).toBe('-0.500000');
    expect(formatCoordParam(1e-7)).toBe('0.000000');
    expect(formatCoordParam(69.1)).not.toMatch(/e/i);
  });

  it('what the map sends is always accepted by the strict parser (round trip)', () => {
    const lat = 41.32651234567891;
    const lng = 69.22853412345678;
    const parsed = parseLatLngParams(formatCoordParam(lat), formatCoordParam(lng));
    expect(parsed).not.toBeNull();
    expect(Math.abs((parsed?.lat ?? 0) - lat)).toBeLessThan(1e-6);
    expect(Math.abs((parsed?.lng ?? 0) - lng)).toBeLessThan(1e-6);
  });

  it('a 15-digit String(number) would be accepted by neither parser path unchanged, so it is never sent', () => {
    expect(parseLatLngParams('41.32651234567891', '69.22853412345678')).toBeNull();
  });

  it('lets the lot be found with an empty cache using only link params', () => {
    const lot = resolveLot(
      { parkingId: ID, lat: formatCoordParam(41.32651234567891), lng: formatCoordParam(69.22853412345678), name: 'Chorsu' },
      [],
    );
    expect(lot?.location).toEqual({ lat: 41.326512, lng: 69.228534 });
  });

  it('still rejects exponents and NaN text', () => {
    expect(parseLatLngParams('4.1e1', '69.2')).toBeNull();
    expect(parseLatLngParams('NaN', '69.2')).toBeNull();
  });
});

describe('cached lot names are sanitized too', () => {
  it('strips invisible characters from the cache name', () => {
    const lot = resolveLot({ parkingId: ID }, [
      { id: ID, name: 'Chorsu‮\u0000 Parking', location: { lat: 41.3, lng: 69.2 } },
    ]);
    expect(lot?.name).toBe('Chorsu Parking');
  });
});
