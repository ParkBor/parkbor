import { describe, expect, it } from 'vitest';

import { resumedOnboardingStep } from '@/lib/onboardingStep';

const named = { first_name: 'Ali' };

describe('resumedOnboardingStep', () => {
  it('resumes the profile step for a signed-in user without a name', () => {
    expect(resumedOnboardingStep({ step: null, isAuthenticated: true, user: { first_name: '' } })).toBe('profile');
    expect(resumedOnboardingStep({ step: null, isAuthenticated: true, user: { first_name: '   ' } })).toBe('profile');
    expect(resumedOnboardingStep({ step: null, isAuthenticated: true, user: {} })).toBe('profile');
    expect(resumedOnboardingStep({ step: null, isAuthenticated: true, user: { first_name: null } })).toBe('profile');
  });

  it('does nothing for a user who has a name', () => {
    expect(resumedOnboardingStep({ step: null, isAuthenticated: true, user: named })).toBeNull();
  });

  it('keeps whatever step the app already has (permissions is never forced back)', () => {
    expect(resumedOnboardingStep({ step: 'permissions', isAuthenticated: true, user: named })).toBe('permissions');
    expect(resumedOnboardingStep({ step: 'profile', isAuthenticated: true, user: named })).toBe('profile');
  });

  it('ignores anonymous sessions and a missing user', () => {
    expect(resumedOnboardingStep({ step: null, isAuthenticated: false, user: { first_name: '' } })).toBeNull();
    expect(resumedOnboardingStep({ step: null, isAuthenticated: true, user: null })).toBeNull();
  });
});
