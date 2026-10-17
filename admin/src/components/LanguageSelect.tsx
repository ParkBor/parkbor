import { Select } from 'antd'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_LANGUAGES } from '../i18n'

/** Language switcher shared by the login screen and the app header. */
export function LanguageSelect() {
  const { t, i18n } = useTranslation()
  return (
    <Select
      value={i18n.resolvedLanguage}
      onChange={(lng) => void i18n.changeLanguage(lng)}
      options={SUPPORTED_LANGUAGES.map((l) => ({ value: l, label: l.toUpperCase() }))}
      aria-label={t('common.language')}
    />
  )
}
