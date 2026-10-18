import type {
  AdminPayment,
  PaymentListParams,
  PaymentProviderName,
  PaymentStatus,
} from '@habi/api-client'
import { useQuery } from '@tanstack/react-query'
import { Select, Space, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { DayRangeFilter } from '../components/DayRangeFilter'
import { ExportButton } from '../components/ExportButton'
import { ListError } from '../components/ListError'
import { PagedTable } from '../components/PagedTable'
import { StatusTag } from '../components/StatusTag'
import { adminApi } from '../lib/api'
import type { ExportColumn } from '../lib/exportXlsx'
import { fetchAll } from '../lib/fetchAll'
import { formatDateTime, formatMoney, safeText } from '../lib/format'
import { type DayRange, toRangeParams } from '../lib/time'
import { useServerTable } from '../lib/useServerTable'

const STATUSES: PaymentStatus[] = ['CREATED', 'PENDING', 'PAID', 'CANCELLED', 'REFUNDED', 'FAILED']
const PROVIDERS: PaymentProviderName[] = ['payme', 'click']

interface Filters {
  status?: PaymentStatus
  provider?: PaymentProviderName
  range: DayRange
}

export default function PaymentsPage() {
  const { t, i18n } = useTranslation()
  const table = useServerTable<Filters>({ range: null })
  const params: PaymentListParams = {
    status: table.filters.status,
    provider: table.filters.provider,
    ...toRangeParams(table.filters.range),
  }
  const query = useQuery({
    queryKey: ['payments', params, table.page, table.pageSize],
    queryFn: () => adminApi.payments.list({ ...params, page: table.page, page_size: table.pageSize }),
  })

  const columns: ColumnsType<AdminPayment> = [
    {
      title: t('payments.booking'),
      key: 'booking',
      render: (_, row) => <Link to={`/bookings/${encodeURIComponent(row.booking)}`}>{row.booking.slice(0, 8)}</Link>,
    },
    { title: t('payments.provider'), key: 'provider', render: (_, row) => safeText(row.provider, 20) },
    { title: t('payments.status'), key: 'status', render: (_, row) => <StatusTag kind="payment" value={row.status} /> },
    { title: t('payments.amount'), key: 'amount', align: 'right', render: (_, row) => formatMoney(row.amount) },
    { title: t('payments.refunded'), key: 'refunded', align: 'right', render: (_, row) => formatMoney(row.refunded_amount) },
    { title: t('payments.performedAt'), key: 'performed', render: (_, row) => formatDateTime(row.performed_at, i18n.language) },
    { title: t('payments.created'), key: 'created', render: (_, row) => formatDateTime(row.created_at, i18n.language) },
  ]
  const exportColumns: ExportColumn<AdminPayment>[] = [
    { header: t('payments.booking'), value: (row) => row.booking },
    { header: t('payments.provider'), value: (row) => row.provider },
    { header: t('payments.status'), value: (row) => row.status },
    { header: t('payments.amount'), value: (row) => row.amount },
    { header: t('payments.refunded'), value: (row) => row.refunded_amount },
    { header: t('payments.performedAt'), value: (row) => formatDateTime(row.performed_at, i18n.language) },
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('payments.title')}
      </Typography.Title>
      <Space wrap>
        <Select
          allowClear
          placeholder={t('payments.status')}
          aria-label={t('payments.status')}
          style={{ minWidth: 160 }}
          value={table.filters.status}
          onChange={(value: PaymentStatus | undefined) => table.setFilter('status', value)}
          options={STATUSES.map((s) => ({ value: s, label: t(`status.payment.${s}`) }))}
        />
        <Select
          allowClear
          placeholder={t('payments.provider')}
          aria-label={t('payments.provider')}
          style={{ minWidth: 140 }}
          value={table.filters.provider}
          onChange={(value: PaymentProviderName | undefined) => table.setFilter('provider', value)}
          options={PROVIDERS.map((p) => ({ value: p, label: p }))}
        />
        <DayRangeFilter value={table.filters.range} onChange={(range) => table.setFilter('range', range)} />
        <ExportButton
          filename="payments"
          columns={exportColumns}
          loadRows={() => fetchAll((paging) => adminApi.payments.list({ ...params, ...paging }))}
        />
      </Space>
      {query.isError ? <ListError error={query.error} onRetry={() => void query.refetch()} /> : null}
      <PagedTable<AdminPayment>
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
