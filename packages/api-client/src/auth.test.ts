import { describe, expect, it, vi } from 'vitest'
import { createAuthApi, type TelegramWidgetPayload } from './auth'
import { createHttpClient } from './http'

type Call = [string, RequestInit]

function setup(response: Response) {
  const fetchImpl = vi.fn(async () => response)
  const http = createHttpClient({ baseUrl: '/api/v1', fetchImpl, getToken: () => 'acc' })
  return {
    api: createAuthApi(http),
    fetchImpl,
    last: () => (fetchImpl.mock.calls as unknown as Call[])[0],
  }
}

const user = {
  id: 'u1',
  telegram_id: 1,
  telegram_username: 'a',
  phone: null,
  first_name: 'A',
  last_name: '',
  language: 'uz',
  role: 'ADMIN',
  tg_notifications: true,
}

describe('auth api', () => {
  it('loginWithTelegramWidget posts the payload verbatim, including unknown fields', async () => {
    const { api, last } = setup(new Response(JSON.stringify({ access: 'a', refresh: 'r', user, is_new: false })))
    const payload = { id: 5, auth_date: 1, hash: 'h', first_name: ' Ali ', extra_field: 'x' } as TelegramWidgetPayload
    const result = await api.loginWithTelegramWidget(payload)
    const [url, init] = last()
    expect(url).toBe('/api/v1/auth/telegram/widget')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual(payload)
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
    expect(result.access).toBe('a')
  })

  it('refreshTokens posts {refresh}', async () => {
    const { api, last } = setup(new Response(JSON.stringify({ access: 'a2', refresh: 'r2' })))
    expect(await api.refreshTokens('r1')).toEqual({ access: 'a2', refresh: 'r2' })
    expect(last()[0]).toBe('/api/v1/auth/token/refresh')
    expect(JSON.parse(last()[1].body as string)).toEqual({ refresh: 'r1' })
  })

  it('logout posts {refresh} with the bearer token and resolves null on 204', async () => {
    const { api, last } = setup(new Response(null, { status: 204 }))
    expect(await api.logout('r1')).toBeNull()
    expect(last()[0]).toBe('/api/v1/auth/logout')
    expect((last()[1].headers as Record<string, string>).Authorization).toBe('Bearer acc')
  })

  it('getMe reads /me', async () => {
    const { api, last } = setup(new Response(JSON.stringify(user)))
    expect((await api.getMe()).role).toBe('ADMIN')
    expect(last()[0]).toBe('/api/v1/me')
    expect(last()[1].method).toBe('GET')
  })

  it.each([{}, { access: 'a' }, { access: '', refresh: 'r' }, { access: 1, refresh: 'r' }, null])(
    'rejects a 200 refresh response without usable tokens (%j) as a parse error',
    async (body) => {
      const { api } = setup(new Response(JSON.stringify(body)))
      await expect(api.refreshTokens('r1')).rejects.toMatchObject({ kind: 'parse' })
    },
  )

  it('rejects a 200 login response without tokens as a parse error', async () => {
    const { api } = setup(new Response(JSON.stringify({ user })))
    await expect(api.loginWithTelegramWidget({ id: 1, auth_date: 1, hash: 'h' })).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('logout can use an explicit bearer token and its own timeout', async () => {
    const { api, last } = setup(new Response(null, { status: 204 }))
    await api.logout('r1', { bearer: 'old-access', timeoutMs: 1234 })
    expect((last()[1].headers as Record<string, string>).Authorization).toBe('Bearer old-access')
  })

  it('forwards an AbortSignal to getMe', async () => {
    const { api, last } = setup(new Response(JSON.stringify(user)))
    const controller = new AbortController()
    await api.getMe({ signal: controller.signal })
    expect(last()[1].signal).toBeInstanceOf(AbortSignal)
  })
})
