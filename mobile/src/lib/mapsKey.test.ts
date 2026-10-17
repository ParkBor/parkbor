import { describe, expect, it } from 'vitest';

import { resolveGoogleMapsKey } from '../../config/mapsKey';

describe('resolveGoogleMapsKey', () => {
  it('returns the key when present', () => {
    expect(resolveGoogleMapsKey('AIza-test', true)).toBe('AIza-test');
    expect(resolveGoogleMapsKey('AIza-test', false)).toBe('AIza-test');
  });

  it('allows a missing key or the placeholder in development (map stays blank)', () => {
    expect(resolveGoogleMapsKey(undefined, false)).toBeUndefined();
    expect(resolveGoogleMapsKey('', false)).toBeUndefined();
    expect(resolveGoogleMapsKey('replace-me', false)).toBeUndefined();
  });

  it.each([undefined, '', '   ', 'replace-me'])('fails the production build for %j', (value) => {
    expect(() => resolveGoogleMapsKey(value, true)).toThrow(/EXPO_PUBLIC_GOOGLE_MAPS_API_KEY/);
  });
});
