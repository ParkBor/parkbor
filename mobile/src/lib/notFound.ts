import type { GuardRoute, OnboardingStep } from '@/lib/authGuard';
import type { AuthStatus } from '@/store/createAuthStore';

/**
 * Where the "back" button of the not-found screen leads. The screen shows no data from the link
 * (an unknown or hostile `parkbor://...` path says nothing about what exists); the auth guard
 * additionally redirects anonymous users away on its own, this only picks the safe landing.
 */
export function notFoundTarget(input: { status: AuthStatus; onboarding: OnboardingStep }): GuardRoute {
  if (input.status === 'offline') return '/offline';
  if (input.status === 'anonymous') return '/(auth)/welcome';
  if (input.status === 'authenticated' && input.onboarding === 'profile') return '/(auth)/complete-profile';
  if (input.status === 'authenticated' && input.onboarding === 'permissions') return '/(auth)/permissions';
  return input.status === 'authenticated' ? '/(tabs)' : '/(auth)/welcome';
}
