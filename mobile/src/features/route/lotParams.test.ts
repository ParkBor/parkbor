import { describe, expect, it } from 'vitest';

import { firstParam, isUuid, parseCoord, resolveLot, type CachedLot } from '@/features/route/lotParams';

const ID = '3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b';
const cached: CachedLot = { id: ID, name: 'Chorsu', location: { lat: 41.3265, lng: 69.2285 } };

describe('isUuid', () => {
  it('accepts canonical UUIDs only', () => {
    expect(isUuid(ID)).toBe(true);
    expect(isUuid(ID.toUpperCase())).toBe(true);
  });
  it.each(['', 'abc', '123', `${ID}x`, `../${ID}`, 'b2f1', undefined, null, 42])('rejects %j', (value) => {
    expect(isUuid(value as unknown)).toBe(false);
  });
});

describe('firstParam / parseCoord', () => {
  it('takes the first value of repeated params', () => {
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam('a')).toBe('a');
    expect(firstParam(undefined)).toBeUndefined();
    expect(firstParam([])).toBeUndefined();
  });

  it('parses strict decimal numbers within range', () => {
    expect(parseCoord('41.3265', 90)).toBe(41.3265);
    expect(parseCoord('-0.5', 90)).toBe(-0.5);
  });
  it.each(['', 'abc', 'NaN', 'Infinity', '1e3', '91', '41.3;DROP', ' 41', '0x10', undefined])(
    'rejects %j',
    (value) => {
      expect(parseCoord(value, 90)).toBeNull();
    },
  );
});

describe('resolveLot', () => {
  it('prefers the nearby cache over params', () => {
    const lot = resolveLot({ parkingId: ID, lat: '1', lng: '2', name: 'Other' }, [cached]);
    expect(lot).toEqual({ id: ID, name: 'Chorsu', location: cached.location });
  });

  it('falls back to valid params when the cache has no such lot', () => {
    const lot = resolveLot({ parkingId: ID, lat: '41.3', lng: '69.2', name: 'Lot\u0000 X' }, []);
    expect(lot).toEqual({ id: ID, name: 'Lot X', location: { lat: 41.3, lng: 69.2 } });
  });

  it('returns null when neither source can place the lot', () => {
    expect(resolveLot({ parkingId: ID }, [])).toBeNull();
    expect(resolveLot({ parkingId: ID, lat: '41.3' }, [])).toBeNull();
    expect(resolveLot({ parkingId: ID, lat: '999', lng: '69' }, [])).toBeNull();
  });

  it('uses an empty-safe name when only coordinates are given', () => {
    expect(resolveLot({ parkingId: ID, lat: '41.3', lng: '69.2' }, [])?.name).toBe('');
  });

  it('ignores cached lots with another id', () => {
    expect(resolveLot({ parkingId: ID }, [{ ...cached, id: 'other' }])).toBeNull();
  });
});
