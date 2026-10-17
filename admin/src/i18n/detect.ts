export const SUPPORTED_LANGUAGES = ['uz', 'ru', 'en'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]
export const DEFAULT_LANGUAGE: Language = 'uz'
export const LANGUAGE_STORAGE_KEY = 'habi.lang'

function asSupported(value: string | null | undefined): Language | null {
  const base = value?.toLowerCase().split('-')[0]
  return SUPPORTED_LANGUAGES.find((lang) => lang === base) ?? null
}

/** Stored choice wins, then the first supported browser language, else Uzbek. */
export function detectLanguage(
  stored: string | null | undefined,
  browserLanguages: readonly string[],
): Language {
  const fromStorage = stored && stored.length <= 2 ? asSupported(stored) : null
  if (fromStorage) return fromStorage
  for (const candidate of browserLanguages) {
    const match = asSupported(candidate)
    if (match) return match
  }
  return DEFAULT_LANGUAGE
}
