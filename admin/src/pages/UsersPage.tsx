import type { AdminUser, UserRole, UserUpdate } from '@habi/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Input, Modal, Select, Space, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useTranslation } from 'react-i18next'
import { ListError } from '../components/ListError'
import { PagedTable } from '../components/PagedTable'
import { StatusTag } from '../components/StatusTag'
import { adminApi } from '../lib/api'
import { useAuth } from '../lib/auth'
import { userErrorText } from '../lib/errorText'
import { formatDateTime, safeText, shortId } from '../lib/format'
import { usePagedQuery } from '../lib/usePagedQuery'
import { isSuperAdmin } from '../lib/rbac'
import { useServerTable } from '../lib/useServerTable'
import { useSingleFlight } from '../lib/useSingleFlight'

const ROLES: UserRole[] = ['DRIVER', 'OPERATOR', 'OWNER', 'ADMIN']

interface Filters {
  role?: UserRole
  active?: boolean
  search: string
}

function displayName(user: AdminUser): string {
  const full = `${user.first_name} ${user.last_name}`.trim()
  return safeText(full || user.telegram_username, 80) || '—'
}

/** Users: block / unblock and change roles (ADMIN only; the server enforces it). */
export default function UsersPage() {
  const { t, i18n } = useTranslation()
  const { user: me } = useAuth()
  const queryClient = useQueryClient()
  // Hints only: the server still refuses (super_admin_required) whatever the UI shows.
  const superAdmin = isSuperAdmin(me)
  const table = useServerTable<Filters>({ search: '' })
  const params = {
    role: table.filters.role,
    is_active: table.filters.active,
    search: table.filters.search.trim() || undefined,
  }
  const query = usePagedQuery(['users', params], table, (paging) =>
    adminApi.users.list({ ...params, ...paging }),
  )
  const singleFlight = useSingleFlight()
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UserUpdate }) => adminApi.users.update(id, body),
    onSuccess: () => {
      void message.success(t('common.saved'))
      void queryClient.invalidateQueries({ queryKey: ['users'] })
    },
    onError: (error) => void message.error(userErrorText(error, t)),
  })

  function changeRole(user: AdminUser, role: UserRole) {
    Modal.confirm({
      title: t('users.confirmRole', { name: displayName(user), role: t(`status.role.${role}`) }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      onOk: () =>
        singleFlight(() => update.mutateAsync({ id: user.id, body: { role } }).catch(() => undefined)),
    })
  }

  function toggleActive(user: AdminUser) {
    const block = user.is_active
    Modal.confirm({
      title: t(block ? 'users.confirmBlock' : 'users.confirmUnblock', { name: displayName(user) }),
      okText: t(block ? 'users.block' : 'users.unblock'),
      okButtonProps: { danger: block },
      cancelText: t('common.cancel'),
      onOk: () =>
        singleFlight(() =>
          update.mutateAsync({ id: user.id, body: { is_active: !block } }).catch(() => undefined),
        ),
    })
  }

  const columns: ColumnsType<AdminUser> = [
    {
      title: t('users.id'),
      key: 'id',
      render: (_, row) => (
        <Typography.Text copyable={{ text: row.id, tooltips: [t('users.copyId'), t('operators.copied')] }} title={row.id}>
          {shortId(row.id)}
        </Typography.Text>
      ),
    },
    { title: t('users.name'), key: 'name', render: (_, row) => displayName(row) },
    {
      title: t('users.username'),
      key: 'username',
      render: (_, row) => (row.telegram_username ? `@${safeText(row.telegram_username, 64)}` : '—'),
    },
    {
      title: t('users.role'),
      key: 'role',
      render: (_, row) =>
        row.id === me?.id || (row.role === 'ADMIN' && !superAdmin) ? (
          <StatusTag kind="role" value={row.role} />
        ) : (
          <Select<UserRole>
            size="small"
            aria-label={`${t('users.role')} ${displayName(row)}`}
            value={row.role}
            style={{ minWidth: 130 }}
            onChange={(role) => changeRole(row, role)}
            options={ROLES.filter((r) => r !== 'ADMIN' || superAdmin).map((r) => ({
              value: r,
              label: t(`status.role.${r}`),
            }))}
          />
        ),
    },
    {
      title: t('users.status'),
      key: 'active',
      render: (_, row) => t(row.is_active ? 'users.active' : 'users.blocked'),
    },
    {
      title: t('users.created'),
      key: 'created',
      render: (_, row) => formatDateTime(row.created_at, i18n.language),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      render: (_, row) =>
        row.id === me?.id || (row.role === 'ADMIN' && !superAdmin) ? null : (
          <Button size="small" danger={row.is_active} onClick={() => toggleActive(row)}>
            {t(row.is_active ? 'users.block' : 'users.unblock')}
          </Button>
        ),
    },
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('users.title')}
      </Typography.Title>
      <Space wrap>
        <Select
          allowClear
          placeholder={t('users.role')}
          aria-label={t('users.role')}
          style={{ minWidth: 160 }}
          value={table.filters.role}
          onChange={(value: UserRole | undefined) => table.setFilter('role', value)}
          options={ROLES.map((r) => ({ value: r, label: t(`status.role.${r}`) }))}
        />
        <Select<string>
          allowClear
          placeholder={t('users.status')}
          aria-label={t('users.status')}
          style={{ minWidth: 160 }}
          value={table.filters.active === undefined ? undefined : String(table.filters.active)}
          onChange={(value: string | undefined) => table.setFilter('active', value === undefined ? undefined : value === 'true')}
          options={[
            { value: 'true', label: t('users.active') },
            { value: 'false', label: t('users.blocked') },
          ]}
        />
        <Input.Search
          allowClear
          placeholder={t('users.searchHint')}
          aria-label={t('users.searchHint')}
          style={{ width: 300 }}
          onSearch={(value) => table.setFilter('search', value)}
        />
      </Space>
      {query.isError ? <ListError error={query.error} onRetry={() => void query.refetch()} /> : null}
      <PagedTable<AdminUser>
        columns={columns}
        rows={query.data?.results ?? []}
        total={query.data?.count ?? 0}
        page={table.page}
        pageSize={table.pageSize}
        loading={query.isLoading}
        rowKey={(row) => row.id}
        onPageChange={table.setPage}
      />
    </Space>
  )
}
