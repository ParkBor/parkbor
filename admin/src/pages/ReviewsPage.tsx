import type { AdminReview, ReviewStatus } from '@habi/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, Select, Space, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useTranslation } from 'react-i18next'
import { Can } from '../components/Can'
import { ExportButton } from '../components/ExportButton'
import { ListError } from '../components/ListError'
import { PagedTable } from '../components/PagedTable'
import { ParkingSelect } from '../components/ParkingSelect'
import { StatusTag } from '../components/StatusTag'
import { adminApi } from '../lib/api'
import { errorText } from '../lib/errorText'
import type { ExportColumn } from '../lib/exportXlsx'
import { fetchAll } from '../lib/fetchAll'
import { formatDateTime, safeText } from '../lib/format'
import { usePagedQuery } from '../lib/usePagedQuery'
import { useServerTable } from '../lib/useServerTable'
import { useSingleFlight } from '../lib/useSingleFlight'

const STATUSES: ReviewStatus[] = ['PUBLISHED', 'HIDDEN']
const RATINGS = [1, 2, 3, 4, 5]
const COMMENT_MAX = 1000

interface Filters {
  status?: ReviewStatus
  parking_lot?: string
  rating?: number
}

/** Review moderation: everyone sees the list, only ADMIN hides / restores (server enforces). */
export default function ReviewsPage() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const table = useServerTable<Filters>({})
  const params = { ...table.filters }
  const query = usePagedQuery(['reviews', params], table, (paging) =>
    adminApi.reviews.list({ ...params, ...paging }),
  )
  const singleFlight = useSingleFlight()
  const toggle = useMutation({
    mutationFn: ({ id, hide }: { id: string; hide: boolean }) =>
      hide ? adminApi.reviews.hide(id) : adminApi.reviews.publish(id),
    onSuccess: () => {
      void message.success(t('common.saved'))
      void queryClient.invalidateQueries({ queryKey: ['reviews'] })
    },
    onError: (error) => void message.error(errorText(error, t)),
  })

  const columns: ColumnsType<AdminReview> = [
    { title: t('bookings.lot'), key: 'lot', render: (_, row) => safeText(row.parking_lot?.name, 80) },
    { title: t('reviews.rating'), key: 'rating', render: (_, row) => `${row.rating}/5` },
    {
      title: t('reviews.comment'),
      key: 'comment',
      render: (_, row) => (
        <Typography.Paragraph style={{ margin: 0, maxWidth: 420 }} ellipsis={{ rows: 2, expandable: true }}>
          {safeText(row.comment, COMMENT_MAX)}
        </Typography.Paragraph>
      ),
    },
    { title: t('reviews.status'), key: 'status', render: (_, row) => <StatusTag kind="review" value={row.status} /> },
    { title: t('payments.created'), key: 'created', render: (_, row) => formatDateTime(row.created_at, i18n.language) },
    {
      title: t('common.actions'),
      key: 'actions',
      render: (_, row) => (
        <Can action="review.moderate">
          <Button
            size="small"
            danger={row.status === 'PUBLISHED'}
            loading={toggle.isPending && toggle.variables?.id === row.id}
            disabled={toggle.isPending}
            onClick={() =>
              void singleFlight(() =>
                toggle.mutateAsync({ id: row.id, hide: row.status === 'PUBLISHED' }).catch(() => undefined),
              )
            }
          >
            {t(row.status === 'PUBLISHED' ? 'reviews.hide' : 'reviews.publish')}
          </Button>
        </Can>
      ),
    },
  ]
  const exportColumns: ExportColumn<AdminReview>[] = [
    { header: t('bookings.lot'), value: (row) => row.parking_lot?.name },
    { header: t('reviews.rating'), value: (row) => row.rating },
    { header: t('reviews.comment'), value: (row) => row.comment },
    { header: t('reviews.status'), value: (row) => row.status },
    { header: t('payments.created'), value: (row) => formatDateTime(row.created_at, i18n.language) },
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('reviews.title')}
      </Typography.Title>
      <Space wrap>
        <Select
          allowClear
          placeholder={t('reviews.status')}
          aria-label={t('reviews.status')}
          style={{ minWidth: 160 }}
          value={table.filters.status}
          onChange={(value: ReviewStatus | undefined) => table.setFilter('status', value)}
          options={STATUSES.map((s) => ({ value: s, label: t(`status.review.${s}`) }))}
        />
        <Select
          allowClear
          placeholder={t('reviews.rating')}
          aria-label={t('reviews.rating')}
          style={{ minWidth: 120 }}
          value={table.filters.rating}
          onChange={(value: number | undefined) => table.setFilter('rating', value)}
          options={RATINGS.map((r) => ({ value: r, label: String(r) }))}
        />
        <ParkingSelect value={table.filters.parking_lot} onChange={(id) => table.setFilter('parking_lot', id)} />
        <ExportButton
          filename="reviews"
          columns={exportColumns}
          loadRows={() => fetchAll((paging) => adminApi.reviews.list({ ...params, ...paging }))}
        />
      </Space>
      {query.isError ? <ListError error={query.error} onRetry={() => void query.refetch()} /> : null}
      <PagedTable<AdminReview>
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
