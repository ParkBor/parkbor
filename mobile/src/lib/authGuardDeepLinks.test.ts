import { describe, expect, it } from 'vitest';

import { resolveRedirect } from '@/lib/authGuard';

const signedIn = { status: 'authenticated', onboarding: null } as const;

describe('authGuard: screens outside the tab group', () => {
  it.each([
    ['navigate', '[parkingId]'],
    ['parking', '[id]'],
    ['booking', 'new'],
    ['booking', '[id]'],
    ['booking', 'pay'],
    ['payment', 'result'],
    ['vehicles', 'index'],
    ['vehicles', 'edit'],
  ])('lets a signed-in user stay on %s/%s (deep links must not bounce to the tabs)', (group, leaf) => {
    expect(resolveRedirect({ ...signedIn, segments: [group, leaf] })).toBeNull();
  });

  it.each([['scan'], ['slots'], ['walk-in'], ['join']])(
    'operator/%s: signed-in users stay (role is enforced by the backend), anonymous users and onboarding are redirected',
    (leaf) => {
      const segments = ['operator', leaf];
      expect(resolveRedirect({ ...signedIn, segments })).toBeNull();
      expect(resolveRedirect({ status: 'anonymous', onboarding: null, segments })).toBe('/(auth)/welcome');
      expect(resolveRedirect({ status: 'authenticated', onboarding: 'profile', segments })).toBe('/(auth)/complete-profile');
      expect(resolveRedirect({ status: 'offline', onboarding: null, segments })).toBe('/offline');
      expect(resolveRedirect({ status: 'loading', onboarding: null, segments })).toBeNull();
    },
  );

  it('still sends signed-in users away from auth screens, offline and the empty root', () => {
    expect(resolveRedirect({ ...signedIn, segments: ['(auth)', 'login'] })).toBe('/(tabs)');
    expect(resolveRedirect({ ...signedIn, segments: ['offline'] })).toBe('/(tabs)');
    expect(resolveRedirect({ ...signedIn, segments: [] })).toBe('/(tabs)');
  });

  it('anonymous users are still kept out of the app screens', () => {
    expect(resolveRedirect({ status: 'anonymous', onboarding: null, segments: ['booking', '[id]'] })).toBe('/(auth)/welcome');
  });

  it('parkbor://payment/result: anonymous -> welcome, onboarding -> its step, signed in -> stays (never bounced to the tabs)', () => {
    const segments = ['payment', 'result'];
    expect(resolveRedirect({ status: 'anonymous', onboarding: null, segments })).toBe('/(auth)/welcome');
    expect(resolveRedirect({ status: 'authenticated', onboarding: 'permissions', segments })).toBe('/(auth)/permissions');
    expect(resolveRedirect({ status: 'authenticated', onboarding: null, segments })).toBeNull();
  });

  it('onboarding still wins over deep links', () => {
    expect(resolveRedirect({ status: 'authenticated', onboarding: 'profile', segments: ['booking', '[id]'] })).toBe(
      '/(auth)/complete-profile',
    );
  });
});

describe('authGuard: deep link paths in every auth state', () => {
  const screens: [string, string][] = [
    ['navigate', '[parkingId]'],
    ['parking', '[id]'],
    ['booking', 'new'],
    ['booking', '[id]'],
    ['booking', 'pay'],
    ['payment', 'result'],
    ['vehicles', 'index'],
    ['vehicles', 'edit'],
  ];

  it.each(screens)('anonymous user on %s/%s is sent to the welcome screen', (group, leaf) => {
    expect(resolveRedirect({ status: 'anonymous', onboarding: null, segments: [group, leaf] })).toBe('/(auth)/welcome');
  });

  it.each(screens)('offline bootstrap on %s/%s holds on the retry screen', (group, leaf) => {
    expect(resolveRedirect({ status: 'offline', onboarding: null, segments: [group, leaf] })).toBe('/offline');
  });

  it.each(screens)('while loading, %s/%s is not redirected (the splash screen holds; hooks wait for authentication)', (group, leaf) => {
    expect(resolveRedirect({ status: 'loading', onboarding: null, segments: [group, leaf] })).toBeNull();
  });

  it('an already signed-in app that loses the network stays on the screen (offline QR stays reachable)', () => {
    // "offline" is only a bootstrap outcome of createAuthStore; an authenticated session is never downgraded to it.
    expect(resolveRedirect({ status: 'authenticated', onboarding: null, segments: ['booking', '[id]'] })).toBeNull();
  });
});
