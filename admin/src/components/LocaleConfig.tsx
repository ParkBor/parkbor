import { ConfigProvider } from 'antd'
import enGB from 'antd/locale/en_GB'
import ruRU from 'antd/locale/ru_RU'
import uzUZ from 'antd/locale/uz_UZ'
import { type ReactNode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { theme } from '../theme'

const ANTD_LOCALES = { uz: uzUZ, ru: ruRU, en: enGB } as const

/** Keeps <html lang> and Ant Design's built-in texts (pager, empty state, pickers) in the UI language. */
export function LocaleConfig({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const language = i18n.language in ANTD_LOCALES ? (i18n.language as keyof typeof ANTD_LOCALES) : 'en'
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])
  return <ConfigProvider locale={ANTD_LOCALES[language]} theme={theme}>{children}</ConfigProvider>
}
