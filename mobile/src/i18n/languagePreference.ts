import { SUPPORTED_LANGUAGES } from '@/i18n/resolveLanguage';
import type { Language } from '@/lib/types';

export interface LanguageSlot {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

/** The saved language, or null when nothing valid is stored (or the store fails). */
export async function loadLanguage(slot: LanguageSlot): Promise<Language | null> {
  try {
    const value = await slot.get();
    return SUPPORTED_LANGUAGES.find((lang) => lang === value) ?? null;
  } catch {
    return null;
  }
}

/** Best effort: a failure to persist must never break the UI. */
export async function saveLanguage(slot: LanguageSlot, language: Language): Promise<void> {
  try {
    await slot.set(language);
  } catch {
    // ignore
  }
}
