import type { LotStatus, ParkingLot } from '@habi/api-client'
import { Button, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useTranslation } from 'react-i18next'
import { safeText } from '../lib/format'
import { type ModerationAction, moderationActionsFor } from '../lib/moderation'

interface ParkingsTableProps {
  rows: ParkingLot[]
  total: number
  page: number
  pageSize: number
  isLoading?: boolean
  /** UI hint only (hides buttons); the backend enforces ADMIN-only moderation. */
  canModerate?: boolean
  onPageChange: (page: number, pageSize: number) => void
  onEdit: (id: string) => void
  onModerate?: (id: string, action: ModerationAction) => void
}

const STATUS_COLOR: Record<LotStatus, string> = {
  PENDING_REVIEW: 'gold',
  ACTIVE: 'green',
  SUSPENDED: 'red',
}

export function ParkingsTable({
  rows,
  total,
  page,
  pageSize,
  isLoading,
  canModerate,
  onPageChange,
  onEdit,
  onModerate,
}: ParkingsTableProps) {
  const { t } = useTranslation()

  const columns: ColumnsType<ParkingLot> = [
    { title: t('parkings.name'), key: 'name', render: (_, lot) => safeText(lot.name, 120) },
    { title: t('parkings.address'), key: 'address', render: (_, lot) => safeText(lot.address, 200) },
    {
      title: t('parkings.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: LotStatus) => (
        (Object.hasOwn(STATUS_COLOR, status)
          ? <Tag color={STATUS_COLOR[status]}>{t(`parkings.statuses.${status}`)}</Tag>
          : <Tag>{safeText(status, 40)}</Tag>)
      ),
    },
    {
      title: t('parkings.slots'),
      key: 'slots',
      render: (_, lot) => `${lot.free_slots}/${lot.total_slots}`,
    },
    { title: t('parkings.rating'), key: 'rating', render: (_, lot) => safeText(lot.rating, 8) },
    {
      title: t('common.actions'),
      key: 'actions',
      render: (_, lot) => (
        <Space>
          <Button size="small" onClick={() => onEdit(lot.id)}>
            {t('common.edit')}
          </Button>
          {canModerate && onModerate
            ? moderationActionsFor(lot.status).map((action) => (
                <Button key={action} size="small" onClick={() => onModerate(lot.id, action)}>
                  {t(`parkings.${action}`)}
                </Button>
              ))
            : null}
        </Space>
      ),
    },
  ]

  return (
    <Table<ParkingLot>
      rowKey="id"
      columns={columns}
      dataSource={rows}
      loading={isLoading}
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
