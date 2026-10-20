import { Linking } from 'react-native';
import { useStore } from 'zustand';

import { createLoginStore, type LoginState } from '@/features/auth/createLoginStore';
import type { Language } from '@/lib/types';
import { profileApi } from '@/features/profile/profileService';
import i18n from '@/i18n';
import { authApi } from '@/lib/authApi';
import { getTelegramBotOrEmpty } from '@/lib/config';
import { getDeviceId } from '@/lib/deviceId';
import { secureSlot } from '@/lib/secureRefreshStorage';
import { authStore } from '@/store/auth';
import { useOnboardingStore } from '@/store/onboarding';

function isLanguage(value: string): value is Language {
  return value === 'uz' || value === 'ru' || value === 'en';
}

export const loginStore = createLoginStore({
  api: authApi,
  openUrl: (url) => Linking.openURL(url),
  getDeviceId,
  botName: getTelegramBotOrEmpty(),
  sessionSlot: secureSlot('habi.login_session'),
  now: () => Date.now(),
  onAuthenticated: async ({ access, refresh, user, is_new }) => {
    // Set before the status flips so the auth guard routes new users into onboarding.
    if (is_new) useOnboardingStore.getState().setStep('profile');
    await authStore.getState().setSession({ access, refresh, user });
    // A new account starts with the language the person chose on this phone (notifications follow it).
    if (is_new && isLanguage(i18n.language)) void profileApi.updateLanguage(i18n.language).catch(() => undefined);
  },
});

export function useLoginStore<T>(selector: (state: LoginState) => T): T {
  return useStore(loginStore, selector);
}
