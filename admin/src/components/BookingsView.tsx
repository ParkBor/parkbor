import type {
  AdminBooking,
  BookingKind,
  BookingListParams,
  BookingStatus,
} from '@habi/api-client'
import { Input, Select, Space, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { adminApi } from '../lib/api'
import type { ExportColumn } from '../lib/exportXlsx'
import { fetchAll } from '../lib/fetchAll'
import { formatDateTime, formatMoney, isUuid, safeText, shortId } from '../lib/format'
import { type DayRange, toRangeParams } from '../lib/time'
import { usePagedQuery } from '../lib/usePagedQuery'
import { useServerTable } from '../lib/useServerTable'
import { DayRangeFilter } from './DayRangeFilter'
import { ExportButton } from './ExportButton'
import { ListError } from './ListError'
import { PagedTable } from './PagedTable'
import { ParkingSelect } from './ParkingSelect'
import { StatusTag } from './StatusTag'

const STATUSES: BookingStatus[] = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'ACTIVE',
  'OVERSTAY',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'NO_SHOW',
]
const KINDS: BookingKind[] = ['ONLINE', 'WALK_IN']

interface Filters {
  status?: BookingStatus
  kind?: BookingKind
  parking_lot?: string
  search: string
  range: DayRange
}

interface BookingsViewProps {
  title: string
  /** Filters the user cannot change (e.g. the overstay list is always overstay_status=due). */
  preset?: Pick<BookingListParams, 'overstay_status'>
  exportName: string
}

function toParams(filters: Filters, preset: BookingsViewProps['preset']): BookingListParams {
  return {
    status: filters.status,
    kind: filters.kind,
    parking_lot: filters.parking_lot,
    search: filters.search.trim() || undefined,
    ...toRangeParams(filters.range),
    ...preset,
  }
}

/** Bookings table with server-side paging and filters; the base of the bookings and overstay screens. */
export function BookingsView({ title, preset, exportName }: BookingsViewProps) {
  const { t, i18n } = useTranslation()
  const table = useServerTable<Filters>({ search: '', range: null })
  const params = toParams(table.filters, preset)

  const query = usePagedQuery(['bookings', params], table, (paging) =>
    adminApi.bookings.list({ ...params, ...paging }),
  )

  const columns: ColumnsType<AdminBooking> = [
    {
      title: t('bookings.id'),
      key: 'id',
      render: (_, row) =>
        isUuid(row.id) ? <Link to={`/bookings/${row.id}`}>{shortId(row.id)}</Link> : shortId(row.id),
    },
    { title: t('bookings.lot'), key: 'lot', render: (_, row) => safeText(row.parking_lot?.name, 80) },
    { title: t('bookings.plate'), key: 'plate', render: (_, row) => safeText(row.plate_number, 20) },
    {
      title: t('bookings.status'),
      key: 'status',
      render: (_, row) => <StatusTag kind="booking" value={row.status} />,
    },
    { title: t('bookings.start'), key: 'start', render: (_, row) => formatDateTime(row.start, i18n.language) },
    { title: t('bookings.end'), key: 'end', render: (_, row) => formatDateTime(row.end, i18n.language) },
    { title: t('bookings.amount'), key: 'amount', align: 'right', render: (_, row) => formatMoney(row.amount) },
    { title: t('bookings.paid'), key: 'paid', align: 'right', render: (_, row) => formatMoney(row.paid_amount) },
    {
      title: t('bookings.refund'),
      key: 'refund',
      render: (_, row) =>
        row.refund_status === 'none' ? '—' : <StatusTag kind="refundView" value={row.refund_status} />,
    },
    {
      title: t('bookings.overstay'),
      key: 'overstay',
      render: (_, row) =>
        row.overstay_status === 'none' ? (
          '—'
        ) : (
          <Space size={4} wrap>
            <StatusTag kind="overstay" value={row.overstay_status} />
            <span>
              {row.overstay_minutes} {t('common.minutesShort')} · {formatMoney(row.overstay_amount)}
            </span>
            {row.overstay_needs_review ? <Tag color="red">{t('bookings.needsReview')}</Tag> : null}
          </Space>
        ),
    },
  ]

  const exportColumns: ExportColumn<AdminBooking>[] = [
    { header: t('bookings.id'), value: (row) => row.id },
    { header: t('bookings.lot'), value: (row) => row.parking_lot?.name },
    { header: t('bookings.plate'), value: (row) => row.plate_number },
    { header: t('bookings.status'), value: (row) => row.status },
    { header: t('bookings.start'), value: (row) => formatDateTime(row.start, i18n.language) },
    { header: t('bookings.end'), value: (row) => formatDateTime(row.end, i18n.language) },
    { header: t('bookings.amount'), value: (row) => row.amount },
    { header: t('bookings.paid'), value: (row) => row.paid_amount },
    { header: t('bookings.refund'), value: (row) => row.refund_status },
    { header: t('bookings.overstay'), value: (row) => `${row.overstay_status} ${row.overstay_amount}` },
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {title}
      </Typography.Title>
      <Space wrap>
        {preset ? null : (
          <Select
            allowClear
            placeholder={t('bookings.status')}
            aria-label={t('bookings.status')}
            style={{ minWidth: 180 }}
            value={table.filters.status}
            onChange={(value: BookingStatus | undefined) => table.setFilter('status', value)}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.booking.${s}`) }))}
          />
        )}
        <Select
          allowClear
          placeholder={t('bookings.kind')}
          aria-label={t('bookings.kind')}
          style={{ minWidth: 140 }}
          value={table.filters.kind}
          onChange={(value: BookingKind | undefined) => table.setFilter('kind', value)}
          options={KINDS.map((k) => ({ value: k, label: t(`bookings.kinds.${k}`) }))}
        />
        <ParkingSelect value={table.filters.parking_lot} onChange={(id) => table.setFilter('parking_lot', id)} />
        <DayRangeFilter basis="starts" value={table.filters.range} onChange={(range) => table.setFilter('range', range)} />
        <Input.Search
          allowClear
          placeholder={t('bookings.plate')}
          aria-label={t('bookings.plate')}
          style={{ width: 180 }}
          onSearch={(value) => table.setFilter('search', value)}
        />
        <ExportButton
          filename={exportName}
          columns={exportColumns}
          loadRows={() =>
            fetchAll((paging) => adminApi.bookings.list({ ...params, ...paging }))
          }
        />
      </Space>
      {query.isError ? <ListError error={query.error} onRetry={() => void query.refetch()} /> : null}
      <PagedTable<AdminBooking>
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
