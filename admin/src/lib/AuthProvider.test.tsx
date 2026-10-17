import type { TelegramWidgetPayload } from '@habi/api-client'
import { act, render, waitFor } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeUser } from '../test/authFixtures'
import { adminApi, getAccessToken, setAccessToken, setAuthHooks } from './api'
import {
  type AuthState,
  createMemoryRefreshStore,
  type RefreshTokenStore,
  SessionSupersededError,
  useAuth,
} from './auth'
import { AuthProvider } from './AuthProvider'
import { whenRevocationsSettled } from './session'

const widgetPayload: TelegramWidgetPayload = {
  id: 7,
  auth_date: 1700000000,
  hash: 'a'.repeat(64),
  first_name: ' Ali ',
  future_field: 'x',
}

type Handler = (init: RequestInit) => Response | Promise<Response>
interface Recorded {
  method: string
  path: string
  auth: string | undefined
  body: unknown
}

/** Route table keyed by "METHOD /path" (relative to /api/v1); handlers are consumed in order. */
function mockApi(routes: Record<string, Handler[]>) {
  const recorded: Recorded[] = []
  const queues = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, [...v]]))
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace('/api/v1', '').split('?')[0]
    const method = init.method ?? 'GET'
    recorded.push({
      method,
      path,
      auth: (init.headers as Record<string, string>).Authorization,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    })
    const handler = queues[`${method} ${path}`]?.shift()
    if (!handler) return new Response(JSON.stringify({ detail: 'unexpected' }), { status: 500 })
    return handler(init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { recorded, fetchMock }
}

const ok =
  (body: unknown, status = 200): Handler =>
  () =>
    new Response(body === null ? null : JSON.stringify(body), { status })

const down: Handler = () => {
  throw new TypeError('Failed to fetch')
}

function gate() {
  let open: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const gated =
  (g: { promise: Promise<void> }, response: Handler): Handler =>
  async (init) => {
    await g.promise
    return response(init)
  }

const emptyPage = { count: 0, next: null, previous: null, results: [] }
const loginOk = (access = 'a1', refresh = 'r1'): Handler =>
  ok({ access, refresh, user: makeUser(), is_new: false })

interface ProviderOptions {
  strict?: boolean
  onSessionCleared?: () => void
}

function renderProvider(store: RefreshTokenStore, options: ProviderOptions = {}) {
  const ref: { current: AuthState | null } = { current: null }
  function Probe() {
    const auth = useAuth()
    useEffect(() => {
      ref.current = auth
    })
    return null
  }
  const tree = (
    <AuthProvider store={store} onSessionCleared={options.onSessionCleared}>
      <Probe />
    </AuthProvider>
  )
  render(options.strict ? <StrictMode>{tree}</StrictMode> : tree)
  return ref as { current: AuthState }
}

beforeEach(() => {
  setAccessToken(null)
  setAuthHooks({})
})
afterEach(async () => {
  await whenRevocationsSettled() // background revokes must not leak into the next test's mocks
  vi.unstubAllGlobals()
  setAccessToken(null)
  setAuthHooks({})
})

const callsTo = (recorded: Recorded[], path: string) => recorded.filter((r) => r.path === path)

describe('bootstrap', () => {
  it('is anonymous immediately and makes no request without a stored refresh token', () => {
    const { fetchMock } = mockApi({})
    const auth = renderProvider(createMemoryRefreshStore())
    expect(auth.current.status).toBe('anonymous')
    expect(auth.current.user).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('restores the session: rotates the refresh token and takes the role from /me', async () => {
    const store = createMemoryRefreshStore('r1')
    const { recorded } = mockApi({
      'POST /auth/token/refresh': [ok({ access: 'a2', refresh: 'r2' })],
      'GET /me': [ok(makeUser('OWNER'))],
    })
    const auth = renderProvider(store)
    expect(auth.current.status).toBe('loading')
    await waitFor(() => expect(auth.current.status).toBe('authenticated'))
    expect(auth.current.user?.role).toBe('OWNER')
    expect(store.get()).toBe('r2')
    expect(getAccessToken()).toBe('a2')
    expect(recorded[0].body).toEqual({ refresh: 'r1' })
    expect(recorded[1].auth).toBe('Bearer a2')
  })

  it.each([
    [401, 'token_not_valid'],
    [401, 'user_not_found'],
    [401, 'user_inactive'],
    [401, 'no_active_account'],
    [400, 'invalid_token'],
  ])('a refresh token rejected with %i %s ends the session', async (status, code) => {
    const store = createMemoryRefreshStore('dead')
    const { recorded } = mockApi({ 'POST /auth/token/refresh': [ok({ detail: 'bad', code }, status)] })
    const auth = renderProvider(store)
    await waitFor(() => expect(auth.current.status).toBe('anonymous'))
    expect(store.get()).toBeNull()
    expect(getAccessToken()).toBeNull()
    expect(recorded).toHaveLength(1) // no refresh loop
  })

  it.each([
    ['429', ok({ detail: 'slow' }, 429)],
    ['503', ok({ detail: 'down' }, 503)],
    ['network failure', down],
    ['broken body', ok({ nope: true })],
    ['codeless 400 (proxy)', ok({ detail: 'bad request' }, 400)],
    ['codeless 401 (proxy)', ok({ detail: 'nope' }, 401)],
    ['codeless 403 (WAF)', ok({ detail: 'blocked' }, 403)],
    ['404', ok({ code: 'not_found' }, 404)],
    ['408', ok(null, 408)],
    ['410', ok(null, 410)],
    ['401 with an unrelated code', ok({ code: 'throttled' }, 401)],
  ])('keeps the stored session when the refresh is unavailable (%s) and can retry', async (_name, handler) => {
    const store = createMemoryRefreshStore('r1')
    mockApi({
      'POST /auth/token/refresh': [handler, ok({ access: 'a2', refresh: 'r2' })],
      'GET /me': [ok(makeUser())],
    })
    const auth = renderProvider(store)
    await waitFor(() => expect(auth.current.status).toBe('unavailable'))
    expect(store.get()).toBe('r1') // not logged out
    await act(async () => {
      auth.current.retry()
    })
    await waitFor(() => expect(auth.current.status).toBe('authenticated'))
    expect(store.get()).toBe('r2')
  })

  it('refreshes only once under React StrictMode (rotation would reject a second use)', async () => {
    const store = createMemoryRefreshStore('r1')
    const { recorded } = mockApi({
      'POST /auth/token/refresh': [ok({ access: 'a2', refresh: 'r2' })],
      'GET /me': [ok(makeUser())],
    })
    const auth = renderProvider(store, { strict: true })
    await waitFor(() => expect(auth.current.status).toBe('authenticated'))
    expect(callsTo(recorded, '/auth/token/refresh')).toHaveLength(1)
  })

  it('a failing /me with a server error keeps the tokens (unavailable), a 403 ends the session', async () => {
    const keep = createMemoryRefreshStore('r1')
    mockApi({
      'POST /auth/token/refresh': [ok({ access: 'a2', refresh: 'r2' })],
      'GET /me': [ok({ detail: 'x' }, 500)],
    })
    const first = renderProvider(keep)
    await waitFor(() => expect(first.current.status).toBe('unavailable'))
    expect(keep.get()).toBe('r2')
    expect(getAccessToken()).toBe('a2')
  })

  it('a codeless 403 from /me (WAF) keeps the session', async () => {
    const store = createMemoryRefreshStore('r1')
    mockApi({
      'POST /auth/token/refresh': [ok({ access: 'a2', refresh: 'r2' })],
      'GET /me': [ok({ detail: 'blocked' }, 403)],
    })
    const auth = renderProvider(store)
    await waitFor(() => expect(auth.current.status).toBe('unavailable'))
    expect(store.get()).toBe('r2')
  })

  it('a /me answered 403 account_disabled ends the session', async () => {
    const store = createMemoryRefreshStore('r1')
    mockApi({
      'POST /auth/token/refresh': [ok({ access: 'a2', refresh: 'r2' })],
      'GET /me': [ok({ detail: 'x', code: 'account_disabled' }, 403)],
    })
    const auth = renderProvider(store)
    await waitFor(() => expect(auth.current.status).toBe('anonymous'))
    expect(store.get()).toBeNull()
    expect(getAccessToken()).toBeNull()
  })

  it('does not stay "loading" forever when a login fails while restoring', async () => {
    const store = createMemoryRefreshStore('r1')
    const hold = gate()
    mockApi({
      'POST /auth/token/refresh': [
        gated(hold, ok({ access: 'late-a', refresh: 'late-r' })),
        ok({ access: 'rev-a', refresh: 'rev-r' }),
      ],
      'POST /auth/telegram/widget': [ok({ detail: 'no', code: 'role_not_allowed' }, 403)],
      'POST /auth/logout': [ok(null, 204), ok(null, 204), ok(null, 204)],
    })
    const auth = renderProvider(store)
    expect(auth.current.status).toBe('loading')
    let failure: unknown
    await act(async () => {
      failure = await auth.current.login(widgetPayload).catch((error: unknown) => error)
    })
    expect(failure).toMatchObject({ status: 403 })
    await act(async () => {
      hold.open()
    })
    await waitFor(() => expect(auth.current.status).toBe('anonymous'))
    // both background revocations (the stored session and the stale refresh result) are done
    await whenRevocationsSettled()
  })

  it('an old session instance cannot update state after the store changed', async () => {
    const hold = gate()
    mockApi({
      'POST /auth/token/refresh': [gated(hold, ok({ access: 'a2', refresh: 'r2' }))],
      'GET /me': [ok(makeUser())],
    })
    const ref: { current: AuthState | null } = { current: null }
    function Probe() {
      const auth = useAuth()
      useEffect(() => {
        ref.current = auth
      })
      return null
    }
    const view = render(
      <AuthProvider store={createMemoryRefreshStore('r1')}>
        <Probe />
      </AuthProvider>,
    )
    view.rerender(
      <AuthProvider store={createMemoryRefreshStore()}>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(ref.current?.status).toBe('anonymous'))
    await act(async () => {
      hold.open()
    })
    await waitFor(() => expect(getAccessToken()).toBe('a2')) // the old bootstrap did finish...
    expect(ref.current?.status).toBe('anonymous') // ...but could not sign the new provider in
  })
})

describe('login', () => {
  it('sends the widget payload unchanged, keeps the access token in memory and the role from /me', async () => {
    const store = createMemoryRefreshStore()
    const { recorded } = mockApi({
      'POST /auth/telegram/widget': [
        ok({ access: 'acc', refresh: 'ref', user: makeUser('DRIVER'), is_new: false }),
      ],
      'GET /me': [ok(makeUser('ADMIN'))], // /me is authoritative
    })
    const auth = renderProvider(store)
    await act(() => auth.current.login(widgetPayload))
    expect(recorded[0].body).toEqual(widgetPayload)
    expect(recorded[1].auth).toBe('Bearer acc')
    expect(auth.current.status).toBe('authenticated')
    expect(auth.current.user?.role).toBe('ADMIN')
    expect(store.get()).toBe('ref')
    expect(getAccessToken()).toBe('acc')
  })

  it('rejects with the API error and stays anonymous when the widget login fails', async () => {
    const store = createMemoryRefreshStore()
    mockApi({ 'POST /auth/telegram/widget': [ok({ detail: 'no', code: 'role_not_allowed' }, 403)] })
    const auth = renderProvider(store)
    await expect(act(() => auth.current.login(widgetPayload))).rejects.toMatchObject({ status: 403 })
    expect(auth.current.status).toBe('anonymous')
    expect(store.get()).toBeNull()
    expect(getAccessToken()).toBeNull()
  })

  it('revokes the new server session when /me fails right after login', async () => {
    const store = createMemoryRefreshStore()
    const { recorded } = mockApi({
      'POST /auth/telegram/widget': [loginOk('acc', 'ref')],
      'GET /me': [ok({ detail: 'x' }, 500)],
      'POST /auth/logout': [ok(null, 204)],
    })
    const auth = renderProvider(store)
    await expect(act(() => auth.current.login(widgetPayload))).rejects.toMatchObject({ status: 500 })
    expect(auth.current.status).toBe('anonymous')
    expect(store.get()).toBeNull()
    expect(getAccessToken()).toBeNull()
    await waitFor(() => expect(callsTo(recorded, '/auth/logout')).toHaveLength(1))
    expect(callsTo(recorded, '/auth/logout')[0]).toMatchObject({ auth: 'Bearer acc', body: { refresh: 'ref' } })
  })

  it('ends the previous session explicitly (revokes it, clears caches) before signing in again', async () => {
    const onSessionCleared = vi.fn()
    const store = createMemoryRefreshStore()
    const { recorded } = mockApi({
      'POST /auth/telegram/widget': [loginOk('a1', 'r1'), loginOk('a2', 'r2')],
      'GET /me': [ok(makeUser()), ok(makeUser('OWNER'))],
      'POST /auth/logout': [ok(null, 204)],
    })
    const auth = renderProvider(store, { onSessionCleared })
    await act(() => auth.current.login(widgetPayload))
    await act(() => auth.current.login(widgetPayload))
    expect(auth.current.user?.role).toBe('OWNER')
    expect(onSessionCleared).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(callsTo(recorded, '/auth/logout')).toHaveLength(1))
    expect(callsTo(recorded, '/auth/logout')[0]).toMatchObject({ auth: 'Bearer a1', body: { refresh: 'r1' } })
    expect(store.get()).toBe('r2')
  })

  it('a login overtaken by a newer one fails loudly and revokes its own tokens', async () => {
    const hold = gate()
    const store = createMemoryRefreshStore()
    const { recorded } = mockApi({
      'POST /auth/telegram/widget': [gated(hold, loginOk('old-a', 'old-r')), loginOk('new-a', 'new-r')],
      'GET /me': [ok(makeUser())],
      'POST /auth/logout': [ok(null, 204)],
    })
    const auth = renderProvider(store)
    const firstResult = auth.current.login(widgetPayload).then(
      () => 'resolved',
      (error: unknown) => error,
    )
    await act(() => auth.current.login(widgetPayload))
    hold.open()
    expect(await firstResult).toBeInstanceOf(SessionSupersededError)
    expect(auth.current.status).toBe('authenticated')
    expect(store.get()).toBe('new-r')
    expect(getAccessToken()).toBe('new-a')
    await waitFor(() => expect(callsTo(recorded, '/auth/logout')).toHaveLength(1))
    expect(callsTo(recorded, '/auth/logout')[0]).toMatchObject({ auth: 'Bearer old-a', body: { refresh: 'old-r' } })
  })

  it('a refresh that was in flight before login cannot overwrite the new session (and is revoked)', async () => {
    const store = createMemoryRefreshStore('old-r')
    const hold = gate()
    const { recorded } = mockApi({
      'POST /auth/token/refresh': [gated(hold, ok({ access: 'stale-a', refresh: 'stale-r' })), ok({ access: 'x', refresh: 'y' })],
      'GET /me': [ok(makeUser())],
      'POST /auth/telegram/widget': [loginOk('new-a', 'new-r')],
      'POST /auth/logout': [ok(null, 204), ok(null, 204), ok(null, 204)],
    })
    const auth = renderProvider(store) // bootstrap refresh is parked on the gate
    await act(() => auth.current.login(widgetPayload))
    hold.open()
    await waitFor(() =>
      expect(callsTo(recorded, '/auth/logout').some((r) => (r.body as { refresh: string }).refresh === 'stale-r')).toBe(true),
    )
    expect(getAccessToken()).toBe('new-a')
    expect(store.get()).toBe('new-r')
    expect(auth.current.status).toBe('authenticated')
  })
})

async function signedIn(extra: Record<string, Handler[]> = {}, options: ProviderOptions = {}) {
  const store = createMemoryRefreshStore()
  const defaults: Record<string, Handler[]> = {
    'POST /auth/telegram/widget': [loginOk('a1', 'r1')],
    'GET /me': [ok(makeUser())],
  }
  const merged = Object.fromEntries(
    [...new Set([...Object.keys(defaults), ...Object.keys(extra)])].map((key) => [
      key,
      [...(defaults[key] ?? []), ...(extra[key] ?? [])],
    ]),
  )
  const api = mockApi(merged)
  const auth = renderProvider(store, options)
  await act(() => auth.current.login(widgetPayload))
  api.recorded.length = 0
  return { store, auth, ...api }
}

describe('401 handling through the wired hooks', () => {
  it('refreshes once and retries the failed request with the rotated token', async () => {
    const { store, recorded } = await signedIn({
      'GET /admin/parkings': [ok({ detail: 'expired' }, 401), ok(emptyPage)],
      'POST /auth/token/refresh': [ok({ access: 'a2', refresh: 'r2' })],
    })
    await adminApi.parkings.list()
    expect(recorded.map((r) => `${r.method} ${r.path} ${r.auth ?? '-'}`)).toEqual([
      'GET /admin/parkings Bearer a1',
      'POST /auth/token/refresh -',
      'GET /admin/parkings Bearer a2',
    ])
    expect(store.get()).toBe('r2')
  })

  it('logs out locally once when the refresh token is rejected', async () => {
    const onSessionCleared = vi.fn()
    const { store, auth } = await signedIn(
      {
        'GET /admin/parkings': [ok({}, 401), ok({}, 401)],
        'POST /auth/token/refresh': [ok({ detail: 'dead', code: 'token_not_valid' }, 401)],
      },
      { onSessionCleared },
    )
    await expect(adminApi.parkings.list()).rejects.toMatchObject({ status: 401 })
    await expect(adminApi.parkings.list()).rejects.toMatchObject({ status: 401 })
    await waitFor(() => expect(auth.current.status).toBe('anonymous'))
    expect(store.get()).toBeNull()
    expect(getAccessToken()).toBeNull()
    expect(onSessionCleared).toHaveBeenCalledTimes(1)
  })

  it('revokes the freshly rotated refresh token when the retried request is still 401', async () => {
    const onSessionCleared = vi.fn()
    const { store, auth, recorded } = await signedIn(
      {
        'GET /admin/parkings': [ok({}, 401), ok({}, 401)],
        'POST /auth/token/refresh': [ok({ access: 'a2', refresh: 'r2' })],
        'POST /auth/logout': [ok(null, 204)],
      },
      { onSessionCleared },
    )
    await expect(adminApi.parkings.list()).rejects.toMatchObject({ status: 401 })
    await waitFor(() => expect(auth.current.status).toBe('anonymous'))
    await waitFor(() => expect(callsTo(recorded, '/auth/logout')).toHaveLength(1))
    expect(callsTo(recorded, '/auth/logout')[0]).toMatchObject({ auth: 'Bearer a2', body: { refresh: 'r2' } })
    expect(store.get()).toBeNull()
    expect(onSessionCleared).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['429', ok({ detail: 'slow' }, 429)],
    ['503', ok({ detail: 'down' }, 503)],
    ['network failure', down],
  ])('keeps the session and returns the original 401 when the refresh is unavailable (%s)', async (_n, handler) => {
    const { store, auth } = await signedIn({
      'GET /admin/parkings': [ok({ detail: 'expired' }, 401)],
      'POST /auth/token/refresh': [handler],
    })
    await expect(adminApi.parkings.list()).rejects.toMatchObject({ kind: 'http', status: 401 })
    expect(auth.current.status).toBe('authenticated')
    expect(store.get()).toBe('r1')
    expect(getAccessToken()).toBe('a1')
  })

  it('a refresh that finishes after a new login does not log the new session out', async () => {
    const hold = gate()
    const { store, auth, recorded } = await signedIn({
      'GET /admin/parkings': [ok({}, 401)],
      'POST /auth/token/refresh': [gated(hold, ok({ access: 'a-mid', refresh: 'r-mid' }))],
      'POST /auth/telegram/widget': [loginOk('a2', 'r2')],
      'GET /me': [ok(makeUser('OWNER'))],
      'POST /auth/logout': [ok(null, 204), ok(null, 204)],
    })
    const request = adminApi.parkings.list().catch((e: unknown) => e)
    await waitFor(() => expect(callsTo(recorded, '/auth/token/refresh')).toHaveLength(1))
    await act(() => auth.current.login(widgetPayload))
    hold.open()
    expect(await request).toMatchObject({ status: 401 })
    expect(auth.current.status).toBe('authenticated')
    expect(getAccessToken()).toBe('a2')
    expect(store.get()).toBe('r2')
    await waitFor(() =>
      expect(callsTo(recorded, '/auth/logout').some((r) => (r.body as { refresh: string }).refresh === 'r-mid')).toBe(true),
    )
  })
})

describe('logout', () => {
  it('clears local state immediately and revokes on the server in the background', async () => {
    const hold = gate()
    const onSessionCleared = vi.fn()
    const { store, auth, recorded } = await signedIn(
      { 'POST /auth/logout': [gated(hold, ok(null, 204))] },
      { onSessionCleared },
    )
    await act(() => auth.current.logout()) // resolves although the server has not answered
    expect(auth.current.status).toBe('anonymous')
    expect(auth.current.user).toBeNull()
    expect(store.get()).toBeNull()
    expect(getAccessToken()).toBeNull()
    expect(onSessionCleared).toHaveBeenCalledTimes(1)
    expect(callsTo(recorded, '/auth/logout')).toEqual([
      { method: 'POST', path: '/auth/logout', auth: 'Bearer a1', body: { refresh: 'r1' } },
    ])
    hold.open()
  })

  it.each([
    ['server error', ok({ detail: 'boom' }, 500)],
    ['network failure', down],
  ])('is complete locally even on a %s', async (_n, handler) => {
    const { store, auth } = await signedIn({ 'POST /auth/logout': [handler] })
    await act(() => auth.current.logout())
    expect(auth.current.status).toBe('anonymous')
    expect(store.get()).toBeNull()
  })

  it('revokes the ROTATED token of a refresh that was in flight (no orphan session)', async () => {
    const hold = gate()
    const { store, auth, recorded } = await signedIn({
      'GET /admin/parkings': [ok({}, 401)],
      'POST /auth/token/refresh': [gated(hold, ok({ access: 'a2', refresh: 'r2' }))],
      'POST /auth/logout': [ok({ detail: 'already rotated' }, 400), ok(null, 204)],
    })
    const request = adminApi.parkings.list().catch((e: unknown) => e)
    await waitFor(() => expect(callsTo(recorded, '/auth/token/refresh')).toHaveLength(1))
    await act(() => auth.current.logout())
    hold.open()
    await request
    await waitFor(() => expect(callsTo(recorded, '/auth/logout')).toHaveLength(2))
    expect(callsTo(recorded, '/auth/logout')[1]).toMatchObject({ auth: 'Bearer a2', body: { refresh: 'r2' } })
    expect(auth.current.status).toBe('anonymous')
    expect(store.get()).toBeNull()
    expect(getAccessToken()).toBeNull()
  })

  it('when the access token has expired, refreshes by hand and revokes the new refresh token', async () => {
    const { auth, recorded } = await signedIn({
      'POST /auth/logout': [ok({ detail: 'expired' }, 401), ok(null, 204)],
      'POST /auth/token/refresh': [ok({ access: 'a2', refresh: 'r2' })],
    })
    await act(() => auth.current.logout())
    await waitFor(() => expect(recorded).toHaveLength(3))
    expect(recorded.map((r) => `${r.path} ${JSON.stringify(r.body)} ${r.auth ?? '-'}`)).toEqual([
      '/auth/logout {"refresh":"r1"} Bearer a1',
      '/auth/token/refresh {"refresh":"r1"} -',
      '/auth/logout {"refresh":"r2"} Bearer a2',
    ])
    expect(getAccessToken()).toBeNull() // the temporary pair never became the session
  })

  it('works repeatedly and concurrently: one revoke, no errors, nothing without a session', async () => {
    const { auth, recorded } = await signedIn({ 'POST /auth/logout': [ok(null, 204)] })
    await act(async () => {
      await Promise.all([auth.current.logout(), auth.current.logout()])
      await auth.current.logout()
    })
    await waitFor(() => expect(callsTo(recorded, '/auth/logout')).toHaveLength(1))
    expect(auth.current.status).toBe('anonymous')
  })

  it('makes no request when there is no session at all', async () => {
    const { fetchMock } = mockApi({})
    const auth = renderProvider(createMemoryRefreshStore())
    await act(() => auth.current.logout())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(auth.current.status).toBe('anonymous')
  })
})
