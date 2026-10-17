import type { Language } from '@/lib/types';

export const SUPPORTED_LANGUAGES: readonly Language[] = ['uz', 'ru', 'en'];
export const DEFAULT_LANGUAGE: Language = 'uz';

/** Maps a BCP-47 tag ("ru-RU") to a supported language, falling back to Uzbek. */
export function resolveLanguage(tag: string | null | undefined): Language {
  const base = (tag ?? '').toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LANGUAGES.find((lang) => lang === base) ?? DEFAULT_LANGUAGE;
}
