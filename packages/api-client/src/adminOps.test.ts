import { describe, expect, it, vi } from 'vitest'
import { createAdminApi } from './admin'
import { createHttpClient } from './http'

type Call = [string, RequestInit]

function make() {
  const fetchImpl = vi.fn(async () => new Response('{}'))
  const api = createAdminApi(createHttpClient({ baseUrl: '/api/v1', fetchImpl }))
  const calls = () =>
    (fetchImpl.mock.calls as unknown as Call[]).map(([url, init]) => `${init.method} ${url}`)
  return { api, fetchImpl, calls }
}

describe('admin ops api routes', () => {
  it('maps stats, users, bookings, payments, refunds, reviews, settings and audit logs', async () => {
    const { api, calls } = make()
    await api.stats.overview({ parking_lot: 'lot' })
    await api.stats.revenue({ from: '2026-10-01', to: '2026-10-07' })
    await api.stats.occupancy()
    await api.users.list({ role: 'OWNER', is_active: true, page: 2 })
    await api.users.update('u1', { is_active: false })
    await api.bookings.list({ status: 'ACTIVE', overstay_status: 'due' })
    await api.bookings.get('b1')
    await api.bookings.cancel('b1', { reason: 'x' })
    await api.payments.list({ provider: 'payme' })
    await api.refunds.list({ needs_attention: true })
    await api.refunds.resolve('r1', { outcome: 'done', note: 'ok' })
    await api.reviews.list({ status: 'PUBLISHED' })
    await api.reviews.hide('rv1')
    await api.reviews.publish('rv1')
    await api.settings.get()
    await api.settings.update({ hold_minutes: 10 })
    await api.auditLogs.list({ action: 'refund.resolve' })
    expect(calls()).toEqual([
      'GET /api/v1/admin/stats/overview?parking_lot=lot',
      'GET /api/v1/admin/stats/revenue?from=2026-10-01&to=2026-10-07',
      'GET /api/v1/admin/stats/occupancy',
      'GET /api/v1/admin/users?role=OWNER&is_active=true&page=2',
      'PATCH /api/v1/admin/users/u1',
      'GET /api/v1/admin/bookings?status=ACTIVE&overstay_status=due',
      'GET /api/v1/admin/bookings/b1',
      'POST /api/v1/admin/bookings/b1/cancel',
      'GET /api/v1/admin/payments?provider=payme',
      'GET /api/v1/admin/refunds?needs_attention=true',
      'POST /api/v1/admin/refunds/r1/resolve',
      'GET /api/v1/admin/reviews?status=PUBLISHED',
      'POST /api/v1/admin/reviews/rv1/hide',
      'POST /api/v1/admin/reviews/rv1/publish',
      'GET /api/v1/admin/settings',
      'PATCH /api/v1/admin/settings',
      'GET /api/v1/admin/audit-logs?action=refund.resolve',
    ])
  })

  it('maps operators and one-time invite codes under a lot', async () => {
    const { api, calls } = make()
    await api.operators.list('lot')
    await api.operators.revoke('lot', 'as1')
    await api.invites.list('lot')
    await api.invites.create('lot', { expires_in_hours: 24 })
    await api.invites.create('lot')
    await api.invites.revoke('lot', 'inv1')
    expect(calls()).toEqual([
      'GET /api/v1/admin/parkings/lot/operators',
      'DELETE /api/v1/admin/parkings/lot/operators/as1',
      'GET /api/v1/admin/parkings/lot/operator-invites',
      'POST /api/v1/admin/parkings/lot/operator-invites',
      'POST /api/v1/admin/parkings/lot/operator-invites',
      'DELETE /api/v1/admin/parkings/lot/operator-invites/inv1',
    ])
  })

  it('sends the resolve body and an empty object when creating an invite without options', async () => {
    const { api, fetchImpl } = make()
    await api.refunds.resolve('r1', { outcome: 'retry', note: '' })
    await api.invites.create('lot')
    const calls = fetchImpl.mock.calls as unknown as Call[]
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ outcome: 'retry', note: '' })
    expect(JSON.parse(calls[1][1].body as string)).toEqual({})
  })

  it.each(['', '.', '..'])('rejects the unsafe id %j in every id position', (id) => {
    const { api, fetchImpl } = make()
    expect(() => api.bookings.get(id)).toThrow(TypeError)
    expect(() => api.refunds.resolve(id, { outcome: 'done', note: '' })).toThrow(TypeError)
    expect(() => api.invites.revoke('lot', id)).toThrow(TypeError)
    expect(() => api.operators.revoke(id, 'x')).toThrow(TypeError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('percent-encodes ids', async () => {
    const { api, calls } = make()
    await api.users.update('a/b', { role: 'ADMIN' })
    expect(calls()).toEqual(['PATCH /api/v1/admin/users/a%2Fb'])
  })
})
