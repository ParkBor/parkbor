import { Linking } from 'react-native';
import { useStore } from 'zustand';

import { createLoginStore, type LoginState } from '@/features/auth/createLoginStore';
import { authApi } from '@/lib/authApi';
import { getTelegramBot } from '@/lib/config';
import { getDeviceId } from '@/lib/deviceId';
import { authStore } from '@/store/auth';
import { useOnboardingStore } from '@/store/onboarding';

export const loginStore = createLoginStore({
  api: authApi,
  openUrl: (url) => Linking.openURL(url),
  getDeviceId,
  botName: getTelegramBot(),
  now: () => Date.now(),
  onAuthenticated: async ({ access, refresh, user, is_new }) => {
    // Set before the status flips so the auth guard routes new users into onboarding.
    if (is_new) useOnboardingStore.getState().setStep('profile');
    await authStore.getState().setSession({ access, refresh, user });
  },
});

export function useLoginStore<T>(selector: (state: LoginState) => T): T {
  return useStore(loginStore, selector);
}
