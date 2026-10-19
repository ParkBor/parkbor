import type { OperatorAssignment, OperatorInvite } from '@habi/api-client'
import { useQueryClient } from '@tanstack/react-query'
import { Button, InputNumber, Modal, Space, Tabs, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InviteCodeModal } from '../components/InviteCodeModal'
import { ListError } from '../components/ListError'
import { PagedTable } from '../components/PagedTable'
import { ParkingSelect } from '../components/ParkingSelect'
import { adminApi } from '../lib/api'
import { errorText } from '../lib/errorText'
import { apiErrorCode } from '../lib/errors'
import { formatDateTime, safeText, shortId } from '../lib/format'
import { usePagedQuery } from '../lib/usePagedQuery'
import { useServerTable } from '../lib/useServerTable'
import { useSingleFlight } from '../lib/useSingleFlight'

const DEFAULT_INVITE_HOURS = 72
const MIN_INVITE_HOURS = 1
const MAX_INVITE_HOURS = 168

interface CreatedCode {
  code: string
  expiresAt: string
}

/** Operators of a lot and their consent-based invitation codes (OWNER of the lot or ADMIN). */
export default function OperatorsPage() {
  const { t } = useTranslation()
  const [lotId, setLotId] = useState<string | undefined>()
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Typography.Title level={3} style={{ margin: 0 }}>
        {t('operators.title')}
      </Typography.Title>
      <Typography.Text type="secondary">{t('operators.hint')}</Typography.Text>
      <ParkingSelect value={lotId} onChange={setLotId} />
      {lotId ? (
        <Tabs
          key={lotId}
          items={[
            { key: 'operators', label: t('operators.tabOperators'), children: <OperatorList lotId={lotId} /> },
            { key: 'invites', label: t('operators.tabInvites'), children: <InviteList lotId={lotId} /> },
          ]}
        />
      ) : null}
    </Space>
  )
}

function OperatorList({ lotId }: { lotId: string }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const singleFlight = useSingleFlight()
  const table = useServerTable<Record<string, never>>({})
  const query = usePagedQuery(['operators', lotId], table, (paging) =>
    adminApi.operators.list(lotId, paging),
  )

  function confirmRevoke(row: OperatorAssignment) {
    Modal.confirm({
      title: t('operators.confirmRevoke'),
      okText: t('operators.revoke'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () =>
        singleFlight(async () => {
          try {
            await adminApi.operators.revoke(lotId, row.assignment_id)
            void queryClient.invalidateQueries({ queryKey: ['operators', lotId] })
          } catch (error) {
            void message.error(errorText(error, t))
          }
        }),
    })
  }

  const columns: ColumnsType<OperatorAssignment> = [
    {
      title: t('users.name'),
      key: 'name',
      render: (_, row) => safeText(row.display_name, 80) || shortId(row.id),
    },
    { title: t('operators.since'), key: 'since', render: (_, row) => formatDateTime(row.created_at, i18n.language) },
    {
      title: t('common.actions'),
      key: 'actions',
      render: (_, row) => (
        <Button size="small" danger onClick={() => confirmRevoke(row)}>
          {t('operators.revoke')}
        </Button>
      ),
    },
  ]
  return (
    <>
      {query.isError ? <ListError error={query.error} onRetry={() => void query.refetch()} /> : null}
      <PagedTable<OperatorAssignment>
        columns={columns}
        rows={query.data?.results ?? []}
        total={query.data?.count ?? 0}
        page={table.page}
        pageSize={table.pageSize}
        loading={query.isLoading}
        rowKey={(row) => row.assignment_id}
        onPageChange={table.setPage}
      />
    </>
  )
}

function InviteList({ lotId }: { lotId: string }) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const singleFlight = useSingleFlight()
  const table = useServerTable<Record<string, never>>({})
  const [hours, setHours] = useState<number | null>(DEFAULT_INVITE_HOURS)
  const [creating, setCreating] = useState(false)
  // The one-time code is held in component state only: not in the query / mutation cache.
  const [created, setCreated] = useState<CreatedCode | null>(null)
  const query = usePagedQuery(['operator-invites', lotId], table, (paging) =>
    adminApi.invites.list(lotId, paging),
  )
  const hoursValid =
    hours !== null && Number.isInteger(hours) && hours >= MIN_INVITE_HOURS && hours <= MAX_INVITE_HOURS

  async function create() {
    if (!hoursValid || hours === null) return
    await singleFlight(() => runCreate(hours))
  }

  async function runCreate(validHours: number) {
    setCreating(true)
    try {
      const result = await adminApi.invites.create(lotId, { expires_in_hours: validHours })
      setCreated({ code: result.code, expiresAt: result.expires_at })
      void queryClient.invalidateQueries({ queryKey: ['operator-invites', lotId] })
    } catch (error) {
      const text =
        apiErrorCode(error) === 'invite_limit_reached'
          ? t('operators.limitReached')
          : errorText(error, t)
      void message.error(text)
    } finally {
      setCreating(false)
    }
  }

  function confirmRevoke(invite: OperatorInvite) {
    Modal.confirm({
      title: t('operators.confirmRevokeInvite'),
      okText: t('operators.revokeInvite'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () =>
        singleFlight(async () => {
          try {
            await adminApi.invites.revoke(lotId, invite.id)
            void queryClient.invalidateQueries({ queryKey: ['operator-invites', lotId] })
          } catch (error) {
            void message.error(errorText(error, t))
          }
        }),
    })
  }

  const columns: ColumnsType<OperatorInvite> = [
    { title: t('operators.createdAt'), key: 'created', render: (_, row) => formatDateTime(row.created_at, i18n.language) },
    { title: t('operators.expiresAt'), key: 'expires', render: (_, row) => formatDateTime(row.expires_at, i18n.language) },
    {
      title: t('common.actions'),
      key: 'actions',
      render: (_, row) => (
        <Button size="small" danger onClick={() => confirmRevoke(row)}>
          {t('operators.revokeInvite')}
        </Button>
      ),
    },
  ]
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <label htmlFor="invite-hours">{t('operators.validHours')}</label>
        <InputNumber
          id="invite-hours"
          min={MIN_INVITE_HOURS}
          max={MAX_INVITE_HOURS}
          precision={0}
          value={hours}
          onChange={setHours}
        />
        <Button type="primary" disabled={!hoursValid} loading={creating} onClick={() => void create()}>
          {t('operators.createInvite')}
        </Button>
      </Space>
      {query.isError ? <ListError error={query.error} onRetry={() => void query.refetch()} /> : null}
      <PagedTable<OperatorInvite>
        columns={columns}
        rows={query.data?.results ?? []}
        total={query.data?.count ?? 0}
        page={table.page}
        pageSize={table.pageSize}
        loading={query.isLoading}
        rowKey={(row) => row.id}
        onPageChange={table.setPage}
      />
      <InviteCodeModal
        code={created?.code ?? null}
        expiresAt={created?.expiresAt ?? null}
        onClose={() => setCreated(null)}
      />
    </Space>
  )
}
