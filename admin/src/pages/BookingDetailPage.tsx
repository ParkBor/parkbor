import type { AdminBookingDetail, AdminPayment, AdminRefund, BookingEventRow } from '@habi/api-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Descriptions, Input, Modal, Result, Space, Table, Typography, message } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Can } from '../components/Can'
import { QueryError } from '../components/QueryError'
import { StatusTag } from '../components/StatusTag'
import { adminApi } from '../lib/api'
import { errorText } from '../lib/errorText'
import { formatDateTime, formatMoney, isUuid, safeText } from '../lib/format'

const CANCELLABLE = ['PENDING_PAYMENT', 'CONFIRMED']
const MAX_REASON = 200

export default function BookingDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams()
  if (!isUuid(id)) return <Result status="404" title={t('common.notFound')} />
  return <BookingDetail id={id} />
}

function BookingDetail({ id }: { id: string }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const query = useQuery({ queryKey: ['booking', id], queryFn: () => adminApi.bookings.get(id) })
  const cancel = useMutation({
    mutationFn: () => adminApi.bookings.cancel(id, reason.trim() ? { reason: reason.trim() } : {}),
    onSuccess: () => {
      void message.success(t('bookings.cancelled'))
      setReason('')
      void queryClient.invalidateQueries({ queryKey: ['booking', id] })
      void queryClient.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (error) => void message.error(errorText(error, t)),
  })

  if (query.isError) return <QueryError error={query.error} onRetry={() => void query.refetch()} />
  const booking: AdminBookingDetail | undefined = query.data
  if (!booking) return <Typography.Text>{t('common.loading')}</Typography.Text>
  const when = (iso: string | null) => formatDateTime(iso, i18n.language)

  function confirmCancel() {
    Modal.confirm({
      title: t('bookings.cancelTitle'),
      content: (
        <Input.TextArea
          aria-label={t('bookings.cancelReason')}
          placeholder={t('bookings.cancelReason')}
          maxLength={MAX_REASON}
          onChange={(event) => setReason(event.target.value)}
        />
      ),
      okText: t('bookings.cancelConfirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: () => cancel.mutateAsync().catch(() => undefined),
    })
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('bookings.detailTitle')} {booking.id.slice(0, 8)}
        </Typography.Title>
        <Space>
          <Button onClick={() => navigate(-1)}>{t('common.back')}</Button>
          {CANCELLABLE.includes(booking.status) ? (
            <Can action="booking.cancel">
              <Button danger loading={cancel.isPending} onClick={confirmCancel}>
                {t('bookings.cancel')}
              </Button>
            </Can>
          ) : null}
        </Space>
      </Space>
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label={t('bookings.status')}>
          <StatusTag kind="booking" value={booking.status} />
        </Descriptions.Item>
        <Descriptions.Item label={t('bookings.kind')}>
          {t(`bookings.kinds.${booking.kind}`, { defaultValue: safeText(booking.kind, 20) })}
        </Descriptions.Item>
        <Descriptions.Item label={t('bookings.lot')}>{safeText(booking.parking_lot.name, 80)}</Descriptions.Item>
        <Descriptions.Item label={t('bookings.slot')}>
          {safeText(booking.slot.code, 20)} ({safeText(booking.slot.zone, 40)})
        </Descriptions.Item>
        <Descriptions.Item label={t('bookings.plate')}>{safeText(booking.plate_number, 20)}</Descriptions.Item>
        <Descriptions.Item label={t('bookings.provider')}>
          {booking.payment_provider ? safeText(booking.payment_provider, 20) : '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('bookings.start')}>{when(booking.start)}</Descriptions.Item>
        <Descriptions.Item label={t('bookings.end')}>{when(booking.end)}</Descriptions.Item>
        <Descriptions.Item label={t('bookings.checkedIn')}>{when(booking.checked_in_at)}</Descriptions.Item>
        <Descriptions.Item label={t('bookings.checkedOut')}>{when(booking.checked_out_at)}</Descriptions.Item>
        <Descriptions.Item label={t('bookings.amount')}>{formatMoney(booking.amount)}</Descriptions.Item>
        <Descriptions.Item label={t('bookings.paid')}>{formatMoney(booking.paid_amount)}</Descriptions.Item>
        <Descriptions.Item label={t('bookings.refundPromise')}>{formatMoney(booking.refund_amount)}</Descriptions.Item>
        <Descriptions.Item label={t('bookings.refund')}>
          <StatusTag kind="refundView" value={booking.refund_status} />
        </Descriptions.Item>
        <Descriptions.Item label={t('bookings.overstay')}>
          <StatusTag kind="overstay" value={booking.overstay_status} /> {booking.overstay_minutes}{' '}
          {t('common.minutesShort')} · {formatMoney(booking.overstay_amount)}
        </Descriptions.Item>
        <Descriptions.Item label={t('bookings.created')}>{when(booking.created_at)}</Descriptions.Item>
      </Descriptions>

      <Typography.Title level={4}>{t('bookings.payments')}</Typography.Title>
      <Table<AdminPayment>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={booking.payments}
        locale={{ emptyText: t('common.noData') }}
        columns={[
          { title: t('payments.provider'), render: (_, p) => safeText(p.provider, 20) },
          { title: t('payments.status'), render: (_, p) => <StatusTag kind="payment" value={p.status} /> },
          { title: t('payments.amount'), align: 'right', render: (_, p) => formatMoney(p.amount) },
          { title: t('payments.refunded'), align: 'right', render: (_, p) => formatMoney(p.refunded_amount) },
          { title: t('payments.performedAt'), render: (_, p) => when(p.performed_at) },
        ]}
      />

      <Typography.Title level={4}>{t('bookings.refunds')}</Typography.Title>
      <Table<AdminRefund>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={booking.refunds}
        locale={{ emptyText: t('common.noData') }}
        columns={[
          { title: t('refunds.status'), render: (_, r) => <StatusTag kind="refund" value={r.status} /> },
          { title: t('refunds.amount'), align: 'right', render: (_, r) => formatMoney(r.amount) },
          { title: t('refunds.reason'), render: (_, r) => safeText(r.reason, 40) },
          { title: t('refunds.created'), render: (_, r) => when(r.created_at) },
        ]}
      />
      <Link to="/refunds">{t('nav.refunds')}</Link>

      <Typography.Title level={4}>{t('bookings.history')}</Typography.Title>
      <Table<BookingEventRow>
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={booking.events}
        locale={{ emptyText: t('common.noData') }}
        columns={[
          { title: t('bookings.when'), render: (_, e) => when(e.created_at) },
          { title: t('bookings.transition'), render: (_, e) => `${safeText(e.from_status, 20) || '—'} → ${safeText(e.to_status, 20)}` },
          { title: t('bookings.eventReason'), render: (_, e) => safeText(e.reason, 64) },
        ]}
      />
    </Space>
  )
}
