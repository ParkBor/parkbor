import type { LotStatus } from '@habi/api-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Modal, Select, Space, Typography, message } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ParkingsTable } from '../components/ParkingsTable'
import { QueryError } from '../components/QueryError'
import { adminApi } from '../lib/api'
import { errorText } from '../lib/errorText'
import type { ModerationAction } from '../lib/moderation'
import { DEFAULT_PAGE_SIZE } from '../lib/useServerTable'

const STATUSES: LotStatus[] = ['PENDING_REVIEW', 'ACTIVE', 'SUSPENDED']

/** Lot moderation queue: lots waiting for approval first (ADMIN only). */
export default function ModerationPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [status, setStatus] = useState<LotStatus>('PENDING_REVIEW')

  const query = useQuery({
    queryKey: ['parkings', 'moderation', { page, pageSize, status }],
    queryFn: () =>
      adminApi.parkings.list({ page, page_size: pageSize, status, ordering: 'created_at' }),
  })
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
      onOk: () => moderate.mutateAsync({ id, action }).catch(() => undefined),
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
        onChange={(value) => {
          setStatus(value)
          setPage(1)
        }}
        options={STATUSES.map((s) => ({ value: s, label: t(`parkings.statuses.${s}`) }))}
      />
      {query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <ParkingsTable
        rows={query.data?.results ?? []}
        total={query.data?.count ?? 0}
        page={page}
        pageSize={pageSize}
        isLoading={query.isLoading}
        canModerate
        onPageChange={(nextPage, nextSize) => {
          setPage(nextSize === pageSize ? nextPage : 1)
          setPageSize(nextSize)
        }}
        onEdit={(id) => navigate(`/parkings/${id}/edit`)}
        onModerate={confirmModeration}
      />
    </Space>
  )
}
