import { Result } from 'antd'
import { useTranslation } from 'react-i18next'
import { Outlet } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { canAccess, type Feature } from '../lib/rbac'

interface RequireFeatureProps {
  feature: Feature
}

/** Route guard for one section: a role without access sees 403, not a broken screen. */
export function RequireFeature({ feature }: RequireFeatureProps) {
  const { t } = useTranslation()
  const { user } = useAuth()
  if (!canAccess(user?.role, feature)) {
    return (
      <Result
        status="403"
        title={t('auth.forbidden.title')}
        subTitle={t('auth.forbidden.section')}
      />
    )
  }
  return <Outlet />
}
