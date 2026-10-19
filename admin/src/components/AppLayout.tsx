import { Suspense, useState } from 'react'
import { Button, Layout, Menu, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { navItemsFor, selectedNavPath } from '../lib/navigation'
import { BrandLogo } from './BrandLogo'
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
  // Below the `lg` breakpoint the sider is hidden: the header then carries the mark.
  const [collapsed, setCollapsed] = useState(false)

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="light" breakpoint="lg" collapsedWidth={0} onBreakpoint={setCollapsed}>
        <div style={{ padding: 16 }}>
          <BrandLogo height={40} />
        </div>
        <Menu
          theme="light"
          mode="inline"
          selectedKeys={selected ? [selected] : []}
          onClick={({ key }) => navigate(key)}
          items={items.map((item) => ({ key: item.path, label: t(item.labelKey) }))}
        />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>{collapsed ? <BrandLogo variant="mark" height={32} /> : null}</div>
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
