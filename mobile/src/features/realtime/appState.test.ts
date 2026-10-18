import { describe, expect, it } from 'vitest';

import { isForegroundState } from '@/features/realtime/appState';

describe('isForegroundState', () => {
  it.each([
    ['active', true],
    ['inactive', true],
    ['background', false],
    ['unknown', true],
    ['extension', true],
  ])('%s -> %s', (state, expected) => {
    expect(isForegroundState(state)).toBe(expected);
  });
});
