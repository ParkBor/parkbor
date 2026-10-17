import type { AuthStatus } from '@/store/createAuthStore';

export type OnboardingStep = 'profile' | 'permissions' | null;

export type GuardRoute =
  | '/(auth)/welcome'
  | '/(auth)/complete-profile'
  | '/(auth)/permissions'
  | '/(tabs)'
  | '/offline';

export interface GuardInput {
  status: AuthStatus;
  segments: readonly string[];
  onboarding: OnboardingStep;
}

const ONBOARDING_ROUTE: Record<'profile' | 'permissions', GuardRoute> = {
  profile: '/(auth)/complete-profile',
  permissions: '/(auth)/permissions',
};

const ONBOARDING_ONLY_SCREENS = new Set(['complete-profile', 'permissions']);

/** Returns where to redirect, or null when the current location is allowed. */
export function resolveRedirect({ status, segments, onboarding }: GuardInput): GuardRoute | null {
  if (status === 'loading') return null;

  const [group, leaf] = segments;
  const inAuthGroup = group === '(auth)';

  // Stored session could not be verified (network down): hold on the retry screen.
  if (status === 'offline') return group === 'offline' ? null : '/offline';

  if (status === 'anonymous') {
    if (!inAuthGroup) return '/(auth)/welcome';
    return leaf !== undefined && ONBOARDING_ONLY_SCREENS.has(leaf) ? '/(auth)/welcome' : null;
  }

  if (onboarding) {
    const target = ONBOARDING_ROUTE[onboarding];
    return inAuthGroup && `/(auth)/${leaf}` === target ? null : target;
  }
  // Signed in and onboarded: every app screen (tabs, parking, booking, vehicles, navigate, ...) is
  // allowed. Only the pre-login groups and the root are sent to the tabs - pushing a stack screen
  // changes the segments, and bouncing those would make them unreachable (and break deep links).
  return group === undefined || group === '(auth)' || group === 'offline' ? '/(tabs)' : null;
}
