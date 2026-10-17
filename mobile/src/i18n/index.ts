import { getLocales } from 'expo-localization';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from '@/i18n/en.json';
import { loadLanguage, saveLanguage } from '@/i18n/languagePreference';
import ru from '@/i18n/ru.json';
import { DEFAULT_LANGUAGE, resolveLanguage } from '@/i18n/resolveLanguage';
import uz from '@/i18n/uz.json';
import { secureSlot } from '@/lib/secureRefreshStorage';
import type { Language } from '@/lib/types';

const languageSlot = secureSlot('habi.language');

export function initI18n(): typeof i18n {
  if (i18n.isInitialized) return i18n;
  // eslint-disable-next-line import/no-named-as-default-member
  void i18n.use(initReactI18next).init({
    resources: { uz: { translation: uz }, ru: { translation: ru }, en: { translation: en } },
    lng: resolveLanguage(getLocales()[0]?.languageTag),
    fallbackLng: DEFAULT_LANGUAGE,
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  return i18n;
}

/** Applies the language the user picked last time (device locale is the first-run default). */
export async function restoreSavedLanguage(): Promise<void> {
  const saved = await loadLanguage(languageSlot);
  // eslint-disable-next-line import/no-named-as-default-member
  if (saved && saved !== i18n.language) await i18n.changeLanguage(saved);
}

/** Switches the UI language and remembers the choice. */
export async function setLanguage(language: Language): Promise<void> {
  // eslint-disable-next-line import/no-named-as-default-member
  await i18n.changeLanguage(language);
  await saveLanguage(languageSlot, language);
}

export default i18n;
