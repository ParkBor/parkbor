import type { LotStatus } from '@habi/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Select, Space, Typography, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ListError } from '../components/ListError'
import { ParkingsTable } from '../components/ParkingsTable'
import { adminApi } from '../lib/api'
import { useRole } from '../lib/auth'
import { errorText } from '../lib/errorText'
import type { ModerationAction } from '../lib/moderation'
import { can } from '../lib/rbac'
import { usePagedQuery } from '../lib/usePagedQuery'
import { useServerTable } from '../lib/useServerTable'
import { useSingleFlight } from '../lib/useSingleFlight'

const STATUSES: LotStatus[] = ['PENDING_REVIEW', 'ACTIVE', 'SUSPENDED']

interface Filters {
  status?: LotStatus
}

export default function ParkingsListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const role = useRole()
  const queryClient = useQueryClient()
  const table = useServerTable<Filters>({})
  const { status } = table.filters

  const query = usePagedQuery(['parkings', { status }], table, (paging) =>
    adminApi.parkings.list({ ...paging, status }),
  )

  const singleFlight = useSingleFlight()
  const moderate = useMutation({
    mutationFn: ({ id, action }: { id: string; action: ModerationAction }) =>
      adminApi.parkings[action](id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['parkings'] }),
    onError: (error) => void message.error(errorText(error, t)),
  })

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('parkings.title')}
        </Typography.Title>
        <Space>
          <Select
            allowClear
            placeholder={t('parkings.status')}
            aria-label={t('parkings.status')}
            style={{ minWidth: 180 }}
            value={status}
            onChange={(value: LotStatus | undefined) => table.setFilter('status', value)}
            options={STATUSES.map((s) => ({ value: s, label: t(`parkings.statuses.${s}`) }))}
          />
          <Button type="primary" onClick={() => navigate('/parkings/new')}>
            {t('common.create')}
          </Button>
        </Space>
      </Space>
      {query.isError ? <ListError error={query.error} onRetry={() => void query.refetch()} /> : null}
      <ParkingsTable
        rows={query.data?.results ?? []}
        total={query.data?.count ?? 0}
        page={table.page}
        pageSize={table.pageSize}
        isLoading={query.isLoading}
        canModerate={can(role, 'lot.moderate')}
        onPageChange={table.setPage}
        onEdit={(id) => navigate(`/parkings/${id}/edit`)}
        onModerate={(id, action) =>
          void singleFlight(() => moderate.mutateAsync({ id, action }).catch(() => undefined))
        }
      />
    </Space>
  )
}
