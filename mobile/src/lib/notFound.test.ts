import { describe, expect, it } from 'vitest';

import { resolveRedirect } from '@/lib/authGuard';
import { notFoundTarget } from '@/lib/notFound';

describe('notFoundTarget', () => {
  it('signed in and onboarded -> the tabs', () => {
    expect(notFoundTarget({ status: 'authenticated', onboarding: null })).toBe('/(tabs)');
  });

  it('signed in but still onboarding -> the onboarding step, never the tabs', () => {
    expect(notFoundTarget({ status: 'authenticated', onboarding: 'profile' })).toBe('/(auth)/complete-profile');
    expect(notFoundTarget({ status: 'authenticated', onboarding: 'permissions' })).toBe('/(auth)/permissions');
  });

  it('signed out -> welcome', () => {
    expect(notFoundTarget({ status: 'anonymous', onboarding: null })).toBe('/(auth)/welcome');
  });

  it('session not verifiable -> the offline screen', () => {
    expect(notFoundTarget({ status: 'offline', onboarding: null })).toBe('/offline');
  });

  it('still loading -> welcome (the guard takes over once the session is known)', () => {
    expect(notFoundTarget({ status: 'loading', onboarding: null })).toBe('/(auth)/welcome');
  });

  it('every landing is a place the auth guard itself would allow for that state', () => {
    const cases = [
      { status: 'authenticated', onboarding: null },
      { status: 'authenticated', onboarding: 'profile' },
      { status: 'authenticated', onboarding: 'permissions' },
      { status: 'anonymous', onboarding: null },
      { status: 'offline', onboarding: null },
    ] as const;
    for (const input of cases) {
      const target = notFoundTarget(input);
      const segments = target.replace(/^\//, '').split('/');
      expect(resolveRedirect({ ...input, segments }), JSON.stringify(input)).toBeNull();
    }
  });

  it('an unmatched hostile route is bounced by the guard when signed out', () => {
    for (const segments of [['+not-found'], ['evil'], ['booking', '..', 'x']]) {
      expect(resolveRedirect({ status: 'anonymous', segments, onboarding: null })).toBe('/(auth)/welcome');
    }
  });
});
