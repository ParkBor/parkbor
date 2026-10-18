import { describe, expect, it } from 'vitest';

import { classifyClose } from '@/features/realtime/closePolicy';

describe('classifyClose (ARCHITECTURE 12.0 close-code table)', () => {
  it.each([
    [4400, 'fatal'],
    [1009, 'fatal'],
    [4409, 'replaced'],
    [4429, 'rate_limited'],
    [4401, 'auth'],
    [4410, 'immediate'],
    [4408, 'backoff'],
    [1011, 'backoff'],
    [1013, 'backoff'],
    [1006, 'backoff'],
    [1000, 'backoff'],
    [1001, 'backoff'],
    [4000, 'backoff'],
    [4999, 'backoff'],
  ])('code %i -> %s', (code, expected) => {
    expect(classifyClose(code)).toBe(expected);
  });

  it('treats a missing or nonsense code as a network drop', () => {
    expect(classifyClose(undefined)).toBe('backoff');
    expect(classifyClose(Number.NaN)).toBe('backoff');
    expect(classifyClose(-1)).toBe('backoff');
  });

  it('never auto-reconnects on the four stop codes', () => {
    for (const code of [4400, 1009, 4409, 4429]) {
      expect(['fatal', 'replaced', 'rate_limited']).toContain(classifyClose(code));
    }
  });
});
