import type { AuditLogParams, AuditLogRow } from '@habi/api-client'
import { Input, Space, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useTranslation } from 'react-i18next'
import { DayRangeFilter } from '../components/DayRangeFilter'
import { ExportButton } from '../components/ExportButton'
import { ListError } from '../components/ListError'
import { PagedTable } from '../components/PagedTable'
import { adminApi } from '../lib/api'
import type { ExportColumn } from '../lib/exportXlsx'
import { fetchAll } from '../lib/fetchAll'
import { formatDateTime, isUuid, metaText, safeText, shortId } from '../lib/format'
import { type DayRange, toRangeParams } from '../lib/time'
import { usePagedQuery } from '../lib/usePagedQuery'
import { useServerTable } from '../lib/useServerTable'


interface Filters {
  action: string
  target_type: string
  actor: string
  range: DayRange
}

/** Read-only audit trail with filters (ADMIN only). */
export default function AuditLogPage() {
  const { t, i18n } = useTranslation()
  const table = useServerTable<Filters>({ action: '', target_type: '', actor: '', range: null })
  const { filters } = table
  const params: AuditLogParams = {
    action: filters.action.trim() || undefined,
    target_type: filters.target_type.trim() || undefined,
    // A malformed actor id would only produce a 400; do not send it.
    actor: isUuid(filters.actor.trim()) ? filters.actor.trim() : undefined,
    ...toRangeParams(filters.range),
  }
  const actorInvalid = filters.actor.trim() !== '' && !isUuid(filters.actor.trim())
  const query = usePagedQuery(['audit-logs', params], table, (paging) =>
    adminApi.auditLogs.list({ ...params, ...paging }),
  )

  const columns: ColumnsType<AuditLogRow> = [
    { title: t('audit.when'), key: 'when', render: (_, row) => formatDateTime(row.created_at, i18n.language) },
    { title: t('audit.actor'), key: 'actor', render: (_, row) => (row.actor ? shortId(row.actor) : t('audit.system')) },
    { title: t('audit.action'), key: 'action', render: (_, row) => safeText(row.action, 64) },
    {
      title: t('audit.target'),
      key: 'target',
      render: (_, row) => `${safeText(row.target_type, 32)} ${safeText(row.target_id, 64)}`.trim(),
    },
  ]
  const exportColumns: ExportColumn<AuditLogRow>[] = [
    { header: t('audit.when'), value: (row) => formatDateTime(row.created_at, i18n.language) },
    { header: t('audit.actor'), value: (row) => row.actor ?? '' },
    { header: t('audit.action'), value: (row) => row.action },
    { header: t('audit.target'), value: (row) => `${row.target_type} ${row.target_id}` },
    { header: t('audit.details'), value: (row) => metaText(row.meta) },
  ]

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('audit.title')}
      </Typography.Title>
      <Space wrap>
        <Input.Search
          allowClear
          placeholder={t('audit.action')}
          aria-label={t('audit.action')}
          style={{ width: 200 }}
          onSearch={(value) => table.setFilter('action', value)}
        />
        <Input.Search
          allowClear
          placeholder={t('audit.targetType')}
          aria-label={t('audit.targetType')}
          style={{ width: 200 }}
          onSearch={(value) => table.setFilter('target_type', value)}
        />
        <Input
          allowClear
          placeholder={t('audit.actorId')}
          aria-label={t('audit.actorId')}
          status={actorInvalid ? 'error' : undefined}
          style={{ width: 300 }}
          value={filters.actor}
          onChange={(event) => table.setFilter('actor', event.target.value)}
        />
        <DayRangeFilter basis="created" value={filters.range} onChange={(range) => table.setFilter('range', range)} />
        <ExportButton
          filename="audit-log"
          columns={exportColumns}
          loadRows={() => fetchAll((paging) => adminApi.auditLogs.list({ ...params, ...paging }))}
        />
      </Space>
      {actorInvalid ? <Typography.Text type="danger">{t('validation.uuid')}</Typography.Text> : null}
      {query.isError ? <ListError error={query.error} onRetry={() => void query.refetch()} /> : null}
      <PagedTable<AuditLogRow>
        columns={columns}
        rows={query.data?.results ?? []}
        total={query.data?.count ?? 0}
        page={table.page}
        pageSize={table.pageSize}
        loading={query.isLoading}
        rowKey={(row) => row.id}
        onPageChange={table.setPage}
        expandedRowRender={(row) => <pre style={{ margin: 0 }}>{metaText(row.meta)}</pre>}
      />
    </Space>
  )
}
