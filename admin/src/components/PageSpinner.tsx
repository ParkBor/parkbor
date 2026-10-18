import { Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { FULL_HEIGHT_CENTER } from '../lib/styles'

/** Accessible loading state (Suspense fallback). */
export function PageSpinner() {
  const { t } = useTranslation()
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label={t('common.loading')} style={FULL_HEIGHT_CENTER}>
      <Spin />
    </div>
  )
}
