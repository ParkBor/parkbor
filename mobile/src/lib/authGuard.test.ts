import { describe, expect, it } from 'vitest';

import { resolveRedirect } from '@/lib/authGuard';

describe('resolveRedirect', () => {
  it('does nothing while the session is loading', () => {
    expect(resolveRedirect({ status: 'loading', segments: ['(tabs)'], onboarding: null })).toBeNull();
    expect(resolveRedirect({ status: 'loading', segments: [], onboarding: null })).toBeNull();
  });

  it('sends anonymous users outside (auth) to welcome', () => {
    expect(resolveRedirect({ status: 'anonymous', segments: ['(tabs)'], onboarding: null })).toBe(
      '/(auth)/welcome',
    );
    expect(resolveRedirect({ status: 'anonymous', segments: [], onboarding: null })).toBe(
      '/(auth)/welcome',
    );
  });

  it('lets anonymous users move within (auth)', () => {
    for (const leaf of ['welcome', 'login', 'code']) {
      expect(resolveRedirect({ status: 'anonymous', segments: ['(auth)', leaf], onboarding: null })).toBeNull();
    }
  });

  it('sends anonymous users away from onboarding-only screens', () => {
    expect(
      resolveRedirect({ status: 'anonymous', segments: ['(auth)', 'complete-profile'], onboarding: null }),
    ).toBe('/(auth)/welcome');
    expect(
      resolveRedirect({ status: 'anonymous', segments: ['(auth)', 'permissions'], onboarding: null }),
    ).toBe('/(auth)/welcome');
  });

  it('sends authenticated users out of (auth) to tabs when no onboarding is pending', () => {
    for (const leaf of ['welcome', 'login', 'code', 'complete-profile', 'permissions']) {
      expect(
        resolveRedirect({ status: 'authenticated', segments: ['(auth)', leaf], onboarding: null }),
      ).toBe('/(tabs)');
    }
  });

  it('leaves authenticated users in (tabs) alone', () => {
    expect(resolveRedirect({ status: 'authenticated', segments: ['(tabs)'], onboarding: null })).toBeNull();
    expect(resolveRedirect({ status: 'authenticated', segments: [], onboarding: null })).toBe('/(tabs)');
  });

  it('routes a new user into the pending onboarding step', () => {
    expect(
      resolveRedirect({ status: 'authenticated', segments: ['(auth)', 'code'], onboarding: 'profile' }),
    ).toBe('/(auth)/complete-profile');
    expect(
      resolveRedirect({ status: 'authenticated', segments: ['(auth)', 'complete-profile'], onboarding: 'profile' }),
    ).toBeNull();
    expect(
      resolveRedirect({ status: 'authenticated', segments: ['(auth)', 'complete-profile'], onboarding: 'permissions' }),
    ).toBe('/(auth)/permissions');
    expect(
      resolveRedirect({ status: 'authenticated', segments: ['(auth)', 'permissions'], onboarding: 'permissions' }),
    ).toBeNull();
  });

  it('parks an unverifiable stored session on the offline screen, wherever the user is', () => {
    for (const segments of [[], ['(tabs)'], ['(auth)', 'login'], ['(auth)', 'welcome']]) {
      expect(resolveRedirect({ status: 'offline', segments, onboarding: null })).toBe('/offline');
    }
    expect(resolveRedirect({ status: 'offline', segments: ['offline'], onboarding: null })).toBeNull();
  });

  it('moves away from the offline screen once the status resolves', () => {
    expect(resolveRedirect({ status: 'authenticated', segments: ['offline'], onboarding: null })).toBe('/(tabs)');
    expect(resolveRedirect({ status: 'anonymous', segments: ['offline'], onboarding: null })).toBe(
      '/(auth)/welcome',
    );
  });

  it('pulls an authenticated user with pending onboarding out of tabs', () => {
    expect(resolveRedirect({ status: 'authenticated', segments: ['(tabs)'], onboarding: 'profile' })).toBe(
      '/(auth)/complete-profile',
    );
  });
});
