import { Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Key, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface PagedTableProps<T> {
  columns: ColumnsType<T>
  rows: T[]
  total: number
  page: number
  pageSize: number
  loading?: boolean
  rowKey: (row: T) => Key
  expandedRowRender?: (row: T) => ReactNode
  onPageChange: (page: number, pageSize: number) => void
}

/** Server-paginated table: the parent owns page/pageSize and fetches one page at a time. */
export function PagedTable<T extends object>({
  columns,
  rows,
  total,
  page,
  pageSize,
  loading,
  rowKey,
  expandedRowRender,
  onPageChange,
}: PagedTableProps<T>) {
  const { t } = useTranslation()
  return (
    <Table<T>
      rowKey={rowKey}
      columns={columns}
      dataSource={rows}
      loading={loading}
      scroll={{ x: 'max-content' }}
      expandable={expandedRowRender ? { expandedRowRender } : undefined}
      locale={{ emptyText: t('common.noData') }}
      pagination={{
        current: page,
        pageSize,
        total,
        showSizeChanger: true,
        showTotal: (count) => t('common.total', { total: count }),
        onChange: onPageChange,
      }}
    />
  )
}
