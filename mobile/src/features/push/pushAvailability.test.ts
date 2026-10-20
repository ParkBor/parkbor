import { describe, expect, it } from 'vitest';

import { canEverGetToken, nextAvailability } from '@/features/push/pushAvailability';

describe('nextAvailability', () => {
  it('a registered or unchanged token proves push works', () => {
    expect(nextAvailability('unknown', 'registered')).toBe('available');
    expect(nextAvailability('unavailable', 'unchanged')).toBe('available');
  });

  it('no token despite a granted permission means push is unavailable', () => {
    expect(nextAvailability('unknown', 'no_token')).toBe('unavailable');
    expect(nextAvailability('available', 'no_token')).toBe('unavailable');
  });

  it.each(['no_permission', 'no_session', 'failed', 'throttled'] as const)('%s says nothing: the previous answer stays', (result) => {
    expect(nextAvailability('unknown', result)).toBe('unknown');
    expect(nextAvailability('available', result)).toBe('available');
    expect(nextAvailability('unavailable', result)).toBe('unavailable');
  });
});

describe('canEverGetToken', () => {
  it('needs a real device and an EAS project id', () => {
    expect(canEverGetToken({ isDevice: true, hasProjectId: true })).toBe(true);
    expect(canEverGetToken({ isDevice: false, hasProjectId: true })).toBe(false);
    expect(canEverGetToken({ isDevice: true, hasProjectId: false })).toBe(false);
  });
});
