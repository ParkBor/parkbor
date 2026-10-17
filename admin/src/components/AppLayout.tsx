import { Button, Layout, Menu, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { LanguageSelect } from './LanguageSelect'

const { Sider, Header, Content } = Layout

const MENU = [
  { key: '/parkings', labelKey: 'nav.parkings' },
  { key: '/zones-slots', labelKey: 'nav.zonesSlots' },
  { key: '/tariffs', labelKey: 'nav.tariffs' },
] as const

export function AppLayout() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { user, logout } = useAuth()
  const selected = MENU.find((item) => pathname.startsWith(item.key))?.key ?? '/parkings'

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth={0}>
        <Typography.Title level={4} style={{ color: '#fff', margin: 16 }}>
          {t('app.title')}
        </Typography.Title>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selected]}
          onClick={({ key }) => navigate(key)}
          items={MENU.map((item) => ({ key: item.key, label: t(item.labelKey) }))}
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
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
