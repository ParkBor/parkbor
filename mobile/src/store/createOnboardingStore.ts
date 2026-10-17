import { createStore, type StoreApi } from 'zustand/vanilla';

import type { OnboardingStep } from '@/lib/authGuard';
import type { AuthStatus } from '@/store/createAuthStore';

export interface OnboardingState {
  step: OnboardingStep;
  setStep: (step: OnboardingStep) => void;
}

/**
 * Post-login steps for new users (profile -> permissions), read by the auth guard.
 * The step is dropped whenever the session ends, so it cannot leak into the next account.
 */
export function createOnboardingStore(auth: {
  subscribe: (listener: (state: { status: AuthStatus }) => void) => unknown;
}): StoreApi<OnboardingState> {
  const store = createStore<OnboardingState>()((set) => ({
    step: null,
    setStep: (step) => set({ step }),
  }));
  auth.subscribe((state) => {
    if (state.status === 'anonymous') store.setState({ step: null });
  });
  return store;
}
