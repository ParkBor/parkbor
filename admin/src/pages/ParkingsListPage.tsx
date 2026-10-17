import { Button, Select, Space, Typography, message } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { LotStatus } from '@habi/api-client'
import { ParkingsTable } from '../components/ParkingsTable'
import { QueryError } from '../components/QueryError'
import { adminApi } from '../lib/api'
import { useRole } from '../lib/auth'
import { describeError } from '../lib/errors'
import type { ModerationAction } from '../lib/moderation'

const STATUSES: LotStatus[] = ['PENDING_REVIEW', 'ACTIVE', 'SUSPENDED']

export default function ParkingsListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const role = useRole()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [status, setStatus] = useState<LotStatus | undefined>()

  const query = useQuery({
    queryKey: ['parkings', { page, pageSize, status }],
    queryFn: () => adminApi.parkings.list({ page, page_size: pageSize, status }),
  })

  const moderate = useMutation({
    mutationFn: ({ id, action }: { id: string; action: ModerationAction }) =>
      adminApi.parkings[action](id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['parkings'] }),
    onError: (error) => void message.error(describeError(error, t('common.error'))),
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
            style={{ minWidth: 180 }}
            value={status}
            onChange={(value: LotStatus | undefined) => {
              setStatus(value)
              setPage(1)
            }}
            options={STATUSES.map((s) => ({ value: s, label: t(`parkings.statuses.${s}`) }))}
          />
          <Button type="primary" onClick={() => navigate('/parkings/new')}>
            {t('common.create')}
          </Button>
        </Space>
      </Space>
      {query.isError ? (
        <QueryError error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <ParkingsTable
        rows={query.data?.results ?? []}
        total={query.data?.count ?? 0}
        page={page}
        pageSize={pageSize}
        isLoading={query.isLoading}
        canModerate={role === 'ADMIN'}
        onPageChange={(nextPage, nextSize) => {
          setPage(nextPage)
          setPageSize(nextSize)
        }}
        onEdit={(id) => navigate(`/parkings/${id}/edit`)}
        onModerate={(id, action) => moderate.mutate({ id, action })}
      />
    </Space>
  )
}
