import type { RevenuePoint } from '@habi/api-client'
import { useQuery } from '@tanstack/react-query'
import { Card, Col, Progress, Row, Space, Statistic, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ListError } from '../components/ListError'
import { ParkingSelect } from '../components/ParkingSelect'
import { adminApi } from '../lib/api'
import { useRole } from '../lib/auth'
import { barPercent, formatMoney, formatPercent, moneyToMinor, percentValue, safeText } from '../lib/format'
import { canAccess } from '../lib/rbac'
import { addDays, tashkentNextDayStart, tashkentDayStart, tashkentToday } from '../lib/time'
import { useState } from 'react'

const REVENUE_DAYS = 7
function maxRevenue(points: RevenuePoint[]): string {
  let best = '0'
  let bestMinor = 0n
  for (const point of points) {
    const minor = moneyToMinor(point.revenue)
    if (minor !== null && minor > bestMinor) {
      best = point.revenue
      bestMinor = minor
    }
  }
  return best
}

/** Counts, revenue and occupancy. The server scopes everything to the caller's lots. */
export default function DashboardPage() {
  const { t } = useTranslation()
  const role = useRole()
  const [lot, setLot] = useState<string | undefined>()
  const params = { parking_lot: lot }
  const today = tashkentToday()
  const from = tashkentDayStart(addDays(today, -(REVENUE_DAYS - 1)))
  const to = tashkentNextDayStart(today)

  const overview = useQuery({
    queryKey: ['stats', 'overview', params],
    queryFn: () => adminApi.stats.overview(params),
  })
  const revenue = useQuery({
    queryKey: ['stats', 'revenue', params, from, to],
    queryFn: () => adminApi.stats.revenue({ ...params, from, to }),
  })
  const occupancy = useQuery({
    queryKey: ['stats', 'occupancy', params],
    queryFn: () => adminApi.stats.occupancy(params),
  })
  const stats = overview.data
  const points = revenue.data?.results ?? []
  const top = maxRevenue(points)

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {t('dashboard.title')}
        </Typography.Title>
        <ParkingSelect value={lot} onChange={setLot} />
      </Space>
      {overview.isError ? <ListError error={overview.error} onRetry={() => void overview.refetch()} /> : null}
      <Row gutter={[16, 16]}>
        <Col xs={24} md={6}>
          <Card loading={overview.isLoading}>
            <Statistic title={t('dashboard.bookingsToday')} value={stats?.bookings_today ?? '—'} />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card loading={overview.isLoading}>
            <Statistic title={t('dashboard.bookingsActive')} value={stats?.bookings_active ?? '—'} />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card loading={overview.isLoading}>
            <Statistic title={t('dashboard.revenueToday')} value={formatMoney(stats?.revenue_today)} />
          </Card>
        </Col>
        <Col xs={24} md={6}>
          <Card loading={overview.isLoading}>
            <Statistic title={t('dashboard.revenueMonth')} value={formatMoney(stats?.revenue_month)} />
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card loading={overview.isLoading} title={t('dashboard.occupancy')}>
            <Progress percent={stats ? percentValue(stats.occupancy_percent) : 0} format={() => formatPercent(stats?.occupancy_percent)} />
            <Typography.Text type="secondary">
              {stats ? `${stats.occupied_slots}/${stats.total_slots}` : '—'}
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card loading={overview.isLoading} title={t('dashboard.attention')}>
            <Space direction="vertical">
              {canAccess(role, 'moderation') ? (
                <Link to="/moderation">
                  {t('dashboard.lotsPending')}: {stats?.lots_pending_review ?? '—'}
                </Link>
              ) : null}
              <Link to="/refunds">
                {t('dashboard.refundsAttention')}: {stats?.refunds_needing_attention ?? '—'}
              </Link>
              <Link to="/overstay">
                {t('dashboard.overstayDue')}: {stats?.overstay_due ?? '—'}
              </Link>
            </Space>
          </Card>
        </Col>
      </Row>
      <Card title={t('dashboard.revenue7')} loading={revenue.isLoading}>
        {revenue.isError ? <ListError error={revenue.error} onRetry={() => void revenue.refetch()} /> : null}
        {points.length === 0 && !revenue.isError ? <Typography.Text>{t('common.noData')}</Typography.Text> : null}
        {points.map((point) => (
          <div key={point.date} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 140px', gap: 8, alignItems: 'center' }}>
            <span>{safeText(point.date, 10)}</span>
            <Progress percent={barPercent(point.revenue, top)} showInfo={false} />
            <span style={{ textAlign: 'right' }}>{formatMoney(point.revenue)}</span>
          </div>
        ))}
      </Card>
      <Card title={t('dashboard.occupancyByLot')} loading={occupancy.isLoading}>
        {occupancy.isError ? <ListError error={occupancy.error} onRetry={() => void occupancy.refetch()} /> : null}
        {(occupancy.data?.results ?? []).map((row) => (
          <div key={row.parking_lot.id} style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 8, alignItems: 'center' }}>
            <span>{safeText(row.parking_lot.name, 60)}</span>
            <Progress percent={percentValue(row.occupancy_percent)} format={() => formatPercent(row.occupancy_percent)} />
          </div>
        ))}
      </Card>
    </Space>
  )
}
