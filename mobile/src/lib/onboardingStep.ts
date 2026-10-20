import type { OnboardingStep } from '@/lib/authGuard';

/**
 * The onboarding step lives in memory, so killing the app mid-onboarding used to skip it. The server
 * knows better: a signed-in user without a name has not finished the profile step. Returns the step
 * to start (null = nothing to resume); permissions are optional and can be asked later, so they are
 * never resumed.
 */
export function resumedOnboardingStep(input: {
  step: OnboardingStep;
  isAuthenticated: boolean;
  user: { first_name?: string | null } | null;
}): OnboardingStep {
  if (input.step !== null) return input.step;
  if (!input.isAuthenticated || input.user === null) return null;
  return (input.user.first_name ?? '').trim() === '' ? 'profile' : null;
}
