import { describe, expect, it, vi } from 'vitest'
import { createAdminApi } from './admin'
import { createHttpClient } from './http'

type Call = [string, RequestInit]

describe('admin api id safety', () => {
  const make = () => {
    const fetchImpl = vi.fn(async () => new Response('{}'))
    return { fetchImpl, api: createAdminApi(createHttpClient({ baseUrl: '/api/v1', fetchImpl })) }
  }

  it('percent-encodes ids so they cannot add path segments or query strings', async () => {
    const { api, fetchImpl } = make()
    await api.parkings.get('..%2f')
    await api.parkings.get('a/b?x=1#y')
    const urls = (fetchImpl.mock.calls as unknown as Call[]).map(([url]) => url)
    expect(urls[0]).toBe('/api/v1/admin/parkings/..%252f')
    expect(urls[1]).toBe('/api/v1/admin/parkings/a%2Fb%3Fx%3D1%23y')
  })

  it.each(['', '.', '..'])('rejects the unsafe id %j', (id) => {
    const { api, fetchImpl } = make()
    expect(() => api.parkings.get(id)).toThrow(TypeError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps the bulk and approve endpoints', async () => {
    const { api, fetchImpl } = make()
    await api.slots.bulk({ zone: 'z', prefix: 'A', start: 1, end: 3, type: 'STANDARD', distance_to_entrance: 0 })
    await api.parkings.approve('lot')
    expect((fetchImpl.mock.calls as unknown as Call[]).map(([url]) => url)).toEqual([
      '/api/v1/admin/slots/bulk',
      '/api/v1/admin/parkings/lot/approve',
    ])
  })
})

describe('admin api routes', () => {
  it('maps every resource method to its method and path', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'))
    const api = createAdminApi(createHttpClient({ baseUrl: '/api/v1', fetchImpl }))
    const lot = { name: 'n', address: 'a', location: { lat: 1, lng: 2 } }
    await api.parkings.list({ page: 2 })
    await api.parkings.get('p')
    await api.parkings.create(lot)
    await api.parkings.update('p', { name: 'x' })
    await api.parkings.remove('p')
    await api.parkings.suspend('p')
    await api.parkings.restore('p')
    await api.zones.list({ parking_lot: 'p' })
    await api.zones.create({ parking_lot: 'p', name: 'A', floor: 0 })
    await api.zones.remove('z')
    await api.slots.list({ zone: 'z' })
    await api.slots.remove('s')
    await api.tariffs.list()
    await api.tariffs.create({ parking_lot: 'p', slot_type: 'EV', price_per_hour: '1.00' })
    await api.tariffs.update('t', { price_per_hour: '2.00' })
    await api.tariffs.remove('t')
    const seen = (fetchImpl.mock.calls as unknown as Call[]).map(([url, init]) => `${init.method} ${url}`)
    expect(seen).toEqual([
      'GET /api/v1/admin/parkings?page=2',
      'GET /api/v1/admin/parkings/p',
      'POST /api/v1/admin/parkings',
      'PATCH /api/v1/admin/parkings/p',
      'DELETE /api/v1/admin/parkings/p',
      'POST /api/v1/admin/parkings/p/suspend',
      'POST /api/v1/admin/parkings/p/restore',
      'GET /api/v1/admin/zones?parking_lot=p',
      'POST /api/v1/admin/zones',
      'DELETE /api/v1/admin/zones/z',
      'GET /api/v1/admin/slots?zone=z',
      'DELETE /api/v1/admin/slots/s',
      'GET /api/v1/admin/tariffs',
      'POST /api/v1/admin/tariffs',
      'PATCH /api/v1/admin/tariffs/t',
      'DELETE /api/v1/admin/tariffs/t',
    ])
  })
})

describe('parking owner by Telegram id', () => {
  it('sends owner_telegram_id as a number in create and PATCH bodies', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'))
    const api = createAdminApi(createHttpClient({ baseUrl: '/api/v1', fetchImpl }))
    await api.parkings.create({ name: 'A', address: 'B', location: { lat: 1, lng: 2 }, owner_telegram_id: 123456789 })
    await api.parkings.update('lot', { owner_telegram_id: 987654321 })
    const bodies = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => JSON.parse(init.body as string))
    expect(bodies[0].owner_telegram_id).toBe(123456789)
    expect(bodies[1]).toEqual({ owner_telegram_id: 987654321 })
    expect('owner' in bodies[0]).toBe(false)
  })
})
