import type { AdminRefund, RefundOutcome, RefundStatus } from '@habi/api-client'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, Button, Select, Space, Switch, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Can } from '../components/Can'
import { ExportButton } from '../components/ExportButton'
import { ListError } from '../components/ListError'
import { PagedTable } from '../components/PagedTable'
import { RefundResolveModal } from '../components/RefundResolveModal'
import { StatusTag } from '../components/StatusTag'
import { adminApi } from '../lib/api'
import type { ExportColumn } from '../lib/exportXlsx'
import { fetchAll } from '../lib/fetchAll'
import { formatDateTime, formatMoney, isUuid, safeText, shortId } from '../lib/format'
import { refundErrorLabel } from '../lib/refundErrors'
import { allowedOutcomes } from '../lib/refundNote'
import { usePagedQuery } from '../lib/usePagedQuery'
import { useServerTable } from '../lib/useServerTable'

const STATUSES: RefundStatus[] = ['PENDING', 'SENT', 'DONE', 'FAILED', 'MANUAL']

interface Filters {
  status?: RefundStatus
  needsAttention: boolean
}

/** Refunds, with the MANUAL / FAILED queue a person must settle (docs 8.4). */
export default function RefundsPage() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const table = useServerTable<Filters>({ needsAttention: true })
  const [selected, setSelected] = useState<AdminRefund | null>(null)
  const params = {
    status: table.filters.status,
    needs_attention: table.filters.needsAttention || undefined,
  }
  const query = usePagedQuery(['refunds', params], table, (paging) =>
    adminApi.refunds.list({ ...params, ...paging }),
  )
  const resolve = useMutation({
    mutationFn: ({ id, outcome, note }: { id: string; outcome: RefundOutcome; note: string }) =>
      adminApi.refunds.resolve(id, { outcome, note }),
    onSuccess: () => {
      void message.success(t('refunds.resolved'))
      void queryClient.invalidateQueries({ queryKey: ['refunds'] })
      void queryClient.invalidateQueries({ queryKey: ['booking'] })
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
    },
  })

  const columns: ColumnsType<AdminRefund> = [
    {
      title: t('payments.booking'),
      key: 'booking',
      render: (_, row) =>
        isUuid(row.booking) ? <Link to={`/bookings/${row.booking}`}>{shortId(row.booking)}</Link> : shortId(row.booking),
    },
    { title: t('refunds.status'), key: 'status', render: (_, row) => <StatusTag kind="refund" value={row.status} /> },
    { title: t('refunds.amount'), key: 'amount', align: 'right', render: (_, row) => formatMoney(row.amount) },
    { title: t('refunds.reason'), key: 'reason', render: (_, row) => safeText(row.reason, 40) },
    { title: t('refunds.attempts'), key: 'attempts', dataIndex: 'attempts' },
    { title: t('refunds.lastError'), key: 'error', render: (_, row) => refundErrorLabel(row.last_error, t) },
    { title: t('refunds.created'), key: 'created', render: (_, row) => formatDateTime(row.created_at, i18n.language) },
    {
      title: t('common.actions'),
      key: 'actions',
      render: (_, row) =>
        allowedOutcomes(row).length > 0 ? (
          <Can action="refund.resolve">
            <Button size="small" type="primary" onClick={() => setSelected(row)}>
              {t('refunds.resolve')}
            </Button>
          </Can>
        ) : null,
    },
  ]
  const exportColumns: ExportColumn<AdminRefund>[] = [
    { header: t('payments.booking'), value: (row) => row.booking },
    { header: t('refunds.status'), value: (row) => row.status },
    { header: t('refunds.amount'), value: (row) => row.amount },
    { header: t('refunds.reason'), value: (row) => row.reason },
    { header: t('refunds.attempts'), value: (row) => row.attempts },
    { header: t('refunds.lastError'), value: (row) => row.last_error },
    { header: t('refunds.created'), value: (row) => formatDateTime(row.created_at, i18n.language) },
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('refunds.title')}
      </Typography.Title>
      <Alert type="info" showIcon message={t('refunds.policyHint')} />
      <Space wrap>
        <Space>
          <Switch
            id="needs-attention"
            checked={table.filters.needsAttention}
            onChange={(checked) => table.setFilter('needsAttention', checked)}
          />
          <label htmlFor="needs-attention">{t('refunds.needsAttention')}</label>
        </Space>
        <Select
          allowClear
          placeholder={t('refunds.status')}
          aria-label={t('refunds.status')}
          style={{ minWidth: 160 }}
          value={table.filters.status}
          onChange={(value: RefundStatus | undefined) => table.setFilter('status', value)}
          options={STATUSES.map((s) => ({ value: s, label: t(`status.refund.${s}`) }))}
        />
        <ExportButton
          filename="refunds"
          columns={exportColumns}
          loadRows={() => fetchAll((paging) => adminApi.refunds.list({ ...params, ...paging }))}
        />
      </Space>
      {query.isError ? <ListError error={query.error} onRetry={() => void query.refetch()} /> : null}
      <PagedTable<AdminRefund>
        columns={columns}
        rows={query.data?.results ?? []}
        total={query.data?.count ?? 0}
        page={table.page}
        pageSize={table.pageSize}
        loading={query.isLoading}
        rowKey={(row) => row.id}
        onPageChange={table.setPage}
      />
      <RefundResolveModal
        refund={selected}
        onClose={() => setSelected(null)}
        onStale={() => void queryClient.invalidateQueries({ queryKey: ['refunds'] })}
        onResolve={(id, outcome, note) => resolve.mutateAsync({ id, outcome, note })}
      />
    </Space>
  )
}
