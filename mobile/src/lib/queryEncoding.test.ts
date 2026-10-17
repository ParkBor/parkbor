import axios from 'axios';
import { describe, expect, it } from 'vitest';

import { buildQueryString } from '@/lib/queryEncoding';

describe('buildQueryString', () => {
  it('encodes the "+" of a UTC offset as %2B (a raw "+" would be read as a space)', () => {
    const query = buildQueryString({ from: '2026-10-15T14:00:00+05:00', to: '2026-10-15T16:00:00+05:00' });
    expect(query).toBe('from=2026-10-15T14%3A00%3A00%2B05%3A00&to=2026-10-15T16%3A00%3A00%2B05%3A00');
    expect(query).not.toContain('+');
  });

  it('leaves a Z instant decodable and unambiguous', () => {
    const query = buildQueryString({ from: '2026-10-15T09:00:00Z' });
    expect(new URLSearchParams(query).get('from')).toBe('2026-10-15T09:00:00Z');
  });

  it('skips undefined and null, keeps false and 0', () => {
    expect(buildQueryString({ a: undefined, b: null, c: false, d: 0, e: 'x' })).toBe('c=false&d=0&e=x');
  });

  it('encodes spaces, ampersands and unicode so values cannot inject parameters', () => {
    const query = buildQueryString({ q: 'a b&c=d', u: 'o‘z' });
    expect(new URLSearchParams(query).get('q')).toBe('a b&c=d');
    expect(new URLSearchParams(query).get('u')).toBe('o‘z');
    expect([...new URLSearchParams(query).keys()]).toEqual(['q', 'u']);
  });

  it('returns an empty string for no parameters', () => {
    expect(buildQueryString({})).toBe('');
  });

  it('is what the wire carries: matches axios own default serialisation of a "+" offset', () => {
    // Documents the verified behaviour: axios would also emit %2B, our serializer is explicit.
    const uri = axios.getUri({ baseURL: 'http://x', url: '/p', params: { from: '2026-10-15T14:00:00+05:00' } });
    expect(uri).toContain('%2B05:00');
    expect(uri).not.toMatch(/\+05/);
  });
});
