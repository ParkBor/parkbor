import { useStore } from 'zustand';

import { authStore } from '@/store/auth';
import { createOnboardingStore, type OnboardingState } from '@/store/createOnboardingStore';

const onboardingStore = createOnboardingStore(authStore);

/** Hook plus `getState()` access to the app-wide onboarding store. */
export function useOnboardingStore<T>(selector: (state: OnboardingState) => T): T {
  return useStore(onboardingStore, selector);
}
useOnboardingStore.getState = onboardingStore.getState;
