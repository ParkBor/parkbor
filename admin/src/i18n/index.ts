import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { DEFAULT_LANGUAGE, detectLanguage, LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES } from './detect'
import { en, ru, uz } from './locales'

export { SUPPORTED_LANGUAGES }

function readStored(): string | null {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY)
  } catch {
    return null
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    uz: { translation: uz },
    ru: { translation: ru },
    en: { translation: en },
  },
  lng: detectLanguage(readStored(), typeof navigator === 'undefined' ? [] : navigator.languages),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
})

// Remember the user's choice (a language preference is not sensitive data).
i18n.on('languageChanged', (lng) => {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lng)
  } catch {
    // storage unavailable (private mode): the choice just is not persisted
  }
})

export default i18n
