import { Button, Result, Space, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { isStaffRole, useAuth } from '../lib/auth'
import { FULL_HEIGHT_CENTER } from '../lib/styles'

/** Gate for the admin routes: anonymous -> /login, signed in without OWNER/ADMIN -> 403. */
export function ProtectedRoute() {
  const { t } = useTranslation()
  const { status, user, logout, retry } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <output aria-busy="true" style={FULL_HEIGHT_CENTER}>
        <Spin />
      </output>
    )
  }
  if (status === 'unavailable') {
    return (
      <Result
        status="warning"
        title={t('auth.unavailable.title')}
        subTitle={t('auth.unavailable.description')}
        extra={
          <Space>
            <Button type="primary" onClick={retry}>
              {t('common.retry')}
            </Button>
            <Button onClick={() => void logout()}>{t('auth.logout')}</Button>
          </Space>
        }
      />
    )
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  if (!isStaffRole(user?.role)) {
    return (
      <Result
        status="403"
        title={t('auth.forbidden.title')}
        subTitle={t('auth.forbidden.description')}
        extra={<Button onClick={() => void logout()}>{t('auth.logout')}</Button>}
      />
    )
  }
  return <Outlet />
}
