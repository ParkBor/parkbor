import type { LotStatus } from '@habi/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Modal, Select, Space, Typography, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ParkingsTable } from '../components/ParkingsTable'
import { ListError } from '../components/ListError'
import { adminApi } from '../lib/api'
import { errorText } from '../lib/errorText'
import type { ModerationAction } from '../lib/moderation'
import { usePagedQuery } from '../lib/usePagedQuery'
import { useServerTable } from '../lib/useServerTable'
import { useSingleFlight } from '../lib/useSingleFlight'

const STATUSES: LotStatus[] = ['PENDING_REVIEW', 'ACTIVE', 'SUSPENDED']

/** Lot moderation queue: lots waiting for approval first (ADMIN only). */
export default function ModerationPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const table = useServerTable<{ status: LotStatus }>({ status: 'PENDING_REVIEW' })
  const { status } = table.filters

  const query = usePagedQuery(['parkings', 'moderation', status], table, (paging) =>
    adminApi.parkings.list({ ...paging, status, ordering: 'created_at' }),
  )
  const singleFlight = useSingleFlight()
  const moderate = useMutation({
    mutationFn: ({ id, action }: { id: string; action: ModerationAction }) =>
      adminApi.parkings[action](id),
    onSuccess: () => {
      void message.success(t('common.saved'))
      void queryClient.invalidateQueries({ queryKey: ['parkings'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
    onError: (error) => void message.error(errorText(error, t)),
  })

  function confirmModeration(id: string, action: ModerationAction) {
    Modal.confirm({
      title: t(`moderation.confirm.${action}`),
      okText: t(`parkings.${action}`),
      okButtonProps: { danger: action === 'suspend' },
      cancelText: t('common.cancel'),
      onOk: () => singleFlight(() => moderate.mutateAsync({ id, action }).catch(() => undefined)),
    })
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('moderation.title')}
      </Typography.Title>
      <Select<LotStatus>
        aria-label={t('parkings.status')}
        style={{ minWidth: 200 }}
        value={status}
        onChange={(value) => table.setFilter('status', value)}
        options={STATUSES.map((s) => ({ value: s, label: t(`parkings.statuses.${s}`) }))}
      />
      {query.isError ? (
        <ListError error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <ParkingsTable
        rows={query.data?.results ?? []}
        total={query.data?.count ?? 0}
        page={table.page}
        pageSize={table.pageSize}
        isLoading={query.isLoading}
        canModerate
        onPageChange={table.setPage}
        onEdit={(id) => navigate(`/parkings/${id}/edit`)}
        onModerate={confirmModeration}
      />
    </Space>
  )
}
