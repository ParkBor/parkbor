import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminApi, authApi, getAccessToken, installAuthHooks, setAccessToken, setAuthHooks } from './api'

// The http client itself is tested in packages/api-client. Here only the wiring of lib/api.ts.

type Call = [string, RequestInit]

function stubFetch(status = 200) {
  const fetchMock = vi.fn(async () => new Response(status === 204 ? null : '{}', { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const lastAuth = (fetchMock: ReturnType<typeof vi.fn>): string | undefined => {
  const calls = fetchMock.mock.calls as unknown as Call[]
  return (calls[calls.length - 1][1].headers as Record<string, string>).Authorization
}

afterEach(() => {
  vi.unstubAllGlobals()
  setAccessToken(null)
  setAuthHooks({})
})

describe('lib/api wiring', () => {
  it('sends the in-memory access token to admin calls but not to credential endpoints', async () => {
    const fetchMock = stubFetch()
    setAccessToken('tok')
    await adminApi.parkings.list()
    expect(lastAuth(fetchMock)).toBe('Bearer tok')
    await authApi.refreshTokens('r').catch(() => undefined)
    expect(lastAuth(fetchMock)).toBeUndefined()
    expect(getAccessToken()).toBe('tok')
  })

  it('a 401 with no session controller installed keeps the session (nothing is known)', async () => {
    const fetchMock = stubFetch(401)
    setAccessToken('tok')
    await expect(adminApi.parkings.list()).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('routes a 401 to the installed hooks, passing the rejected token to onAuthFailure', async () => {
    stubFetch(401)
    setAccessToken('tok')
    const onUnauthorized = vi.fn(async () => 'rejected' as const)
    const onAuthFailure = vi.fn()
    setAuthHooks({ onUnauthorized, onAuthFailure })
    await expect(adminApi.parkings.list()).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(onAuthFailure).toHaveBeenCalledWith('tok')
  })
})

describe('installAuthHooks', () => {
  it('cleanup removes only its own hooks, never those installed later by another owner', async () => {
    stubFetch(401)
    setAccessToken('tok')
    const first = { onUnauthorized: vi.fn(async () => 'unavailable' as const) }
    const second = { onUnauthorized: vi.fn(async () => 'unavailable' as const) }
    const uninstallFirst = installAuthHooks(first)
    installAuthHooks(second)
    uninstallFirst() // stale cleanup of the first owner
    await adminApi.parkings.list().catch(() => undefined)
    expect(second.onUnauthorized).toHaveBeenCalledTimes(1)
    expect(first.onUnauthorized).not.toHaveBeenCalled()
  })

  it('cleanup of the active owner leaves no hooks behind', async () => {
    stubFetch(401)
    setAccessToken('tok')
    const hooks = { onUnauthorized: vi.fn(async () => 'unavailable' as const) }
    installAuthHooks(hooks)()
    await adminApi.parkings.list().catch(() => undefined)
    expect(hooks.onUnauthorized).not.toHaveBeenCalled()
  })
})
