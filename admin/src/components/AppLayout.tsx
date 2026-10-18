import { Suspense } from 'react'
import { Button, Layout, Menu, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { navItemsFor, selectedNavPath } from '../lib/navigation'
import { ErrorBoundary } from './ErrorBoundary'
import { LanguageSelect } from './LanguageSelect'
import { PageSpinner } from './PageSpinner'

const { Sider, Header, Content } = Layout

export function AppLayout() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { user, logout } = useAuth()
  const items = navItemsFor(user?.role)
  const selected = selectedNavPath(pathname)

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth={0}>
        <Typography.Title level={4} style={{ color: '#fff', margin: 16 }}>
          {t('app.title')}
        </Typography.Title>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={selected ? [selected] : []}
          onClick={({ key }) => navigate(key)}
          items={items.map((item) => ({ key: item.path, label: t(item.labelKey) }))}
        />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', textAlign: 'right' }}>
          <Space>
            {user && <Typography.Text>{user.first_name || user.telegram_username}</Typography.Text>}
            <LanguageSelect />
            <Button onClick={() => void logout()}>{t('auth.logout')}</Button>
          </Space>
        </Header>
        <Content style={{ padding: 24 }}>
          <ErrorBoundary resetKey={pathname}>
            <Suspense fallback={<PageSpinner />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </Content>
      </Layout>
    </Layout>
  )
}
