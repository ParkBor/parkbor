import { describe, expect, it, vi } from 'vitest'
import { ApiError, buildQuery, createHttpClient, isAuthEndpoint } from './http'

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status })
}

type Call = [string, RequestInit]
const calls = (f: ReturnType<typeof vi.fn>) => f.mock.calls as unknown as Call[]
const authHeader = (call: Call) => (call[1].headers as Record<string, string>).Authorization

function deferred() {
  let release: (r: Response) => void = () => undefined
  const promise = new Promise<Response>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

type Outcome = boolean | 'refreshed' | 'rejected' | 'unavailable' | 'stale'

function harness(responses: Array<Response | (() => Response | Promise<Response>)>) {
  let token: string | null = 'old'
  const queue = [...responses]
  const fetchImpl = vi.fn(async () => {
    const next = queue.shift()
    if (!next) return json(200, {})
    return typeof next === 'function' ? next() : next
  })
  const onAuthFailure = vi.fn()
  return {
    fetchImpl,
    onAuthFailure,
    setToken: (value: string | null) => {
      token = value
    },
    make: (onUnauthorized?: () => Promise<Outcome>) =>
      createHttpClient({
        baseUrl: '/api/v1',
        fetchImpl,
        getToken: () => token,
        onUnauthorized,
        onAuthFailure,
      }),
  }
}

describe('isAuthEndpoint', () => {
  it.each(['/auth/telegram/widget', '/auth/telegram/verify', '/auth/token/refresh', '/auth/token/refresh?x=1'])(
    'treats %s as a credential endpoint',
    (path) => expect(isAuthEndpoint(path)).toBe(true),
  )
  it.each([
    '/auth/token/refresh/',
    '/auth/token/refresh//',
    '/AUTH/Token/Refresh',
    '/auth/%74oken/refresh',
    '/auth/token/%2e/refresh',
    '/auth/./token/refresh',
    '/x/../auth/token/refresh',
    '/auth//token/refresh',
    '/auth/token/refresh#frag',
    '/auth/telegram/widget/',
    '/auth/%2554oken/refresh',
  ])('treats the disguised %s as a credential endpoint', (path) =>
    expect(isAuthEndpoint(path)).toBe(true),
  )
  it.each([
    '/auth/logout',
    '/auth/logout/',
    '/me',
    '/admin/parkings',
    '/auth/telegram',
    '/auth/token/refreshX',
    '/x/auth/token/refresh',
  ])('does not treat %s as a credential endpoint', (path) =>
    expect(isAuthEndpoint(path)).toBe(false),
  )
})

describe('auth endpoints and 401', () => {
  it('a 401 from the refresh endpoint neither refreshes nor logs out (no deadlock)', async () => {
    const h = harness([json(401, { detail: 'bad refresh' })])
    const onUnauthorized = vi.fn(async () => true)
    const http = h.make(onUnauthorized)
    await expect(http.request('POST', '/auth/token/refresh', { body: { refresh: 'r' } })).rejects.toMatchObject({
      status: 401,
    })
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(h.onAuthFailure).not.toHaveBeenCalled()
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a 401 from the widget login does not trigger refresh or logout', async () => {
    const h = harness([json(401, {})])
    const onUnauthorized = vi.fn(async () => true)
    await expect(h.make(onUnauthorized).request('POST', '/auth/telegram/widget', { body: {} })).rejects.toMatchObject({
      status: 401,
    })
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(h.onAuthFailure).not.toHaveBeenCalled()
  })

  it('does not send the (stale) bearer token to credential endpoints', async () => {
    const h = harness([json(200, {})])
    await h.make().request('POST', '/auth/token/refresh', { body: {} })
    expect(authHeader(calls(h.fetchImpl)[0])).toBeUndefined()
  })

  it('sends the bearer token to /auth/logout', async () => {
    const h = harness([json(204, null)])
    await h.make().request('POST', '/auth/logout', { body: { refresh: 'r' } })
    expect(authHeader(calls(h.fetchImpl)[0])).toBe('Bearer old')
  })
})

describe('401 recovery', () => {
  it('refreshes once and retries with the new token', async () => {
    const h = harness([json(401, {}), json(200, { ok: true })])
    const http = h.make(async () => {
      h.setToken('new')
      return true
    })
    expect(await http.request('GET', '/x')).toEqual({ ok: true })
    expect(calls(h.fetchImpl).map(authHeader)).toEqual(['Bearer old', 'Bearer new'])
  })

  it('parallel 401s share the refresh the hook performs', async () => {
    const h = harness([json(401, {}), json(401, {}), json(200, { n: 1 }), json(200, { n: 2 })])
    let calls = 0
    let release: (value: Outcome) => void = () => undefined
    const gate = new Promise<Outcome>((resolve) => {
      release = resolve
    })
    const hook = () => {
      calls += 1
      return gate
    }
    const http = h.make(hook)
    const both = Promise.all([http.request('GET', '/a'), http.request('GET', '/b')])
    await Promise.resolve()
    release('refreshed')
    await both
    expect(calls).toBe(1)
  })

  it('does not count a hook that throws as a logout', async () => {
    const h = harness([json(401, {})])
    const http = h.make(async () => {
      throw new Error('boom')
    })
    await expect(http.request('GET', '/x')).rejects.toMatchObject({ status: 401 })
    expect(h.onAuthFailure).not.toHaveBeenCalled()
  })
})

describe('onAuthFailure is called once for parallel failures', () => {
  it('three parallel 401s with a rejected refresh log out exactly once', async () => {
    const h = harness([json(401, {}), json(401, {}), json(401, {})])
    const http = h.make(async () => {
      await Promise.resolve()
      return 'rejected'
    })
    const results = await Promise.allSettled([
      http.request('GET', '/a'),
      http.request('GET', '/b'),
      http.request('GET', '/c'),
    ])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(h.onAuthFailure).toHaveBeenCalledTimes(1)
  })

  it('failures in a later session (new token) notify again', async () => {
    const h = harness([json(401, {}), json(401, {})])
    const http = h.make(async () => 'rejected')
    await http.request('GET', '/a').catch(() => undefined)
    h.setToken('fresh')
    await http.request('GET', '/b').catch(() => undefined)
    expect(h.onAuthFailure).toHaveBeenCalledTimes(2)
  })

  it('a request sent after logout (no token) resets the latch', async () => {
    const h = harness([json(401, {}), json(401, {}), json(401, {})])
    const http = h.make(async () => 'rejected')
    await http.request('GET', '/a').catch(() => undefined)
    h.setToken(null)
    await http.request('GET', '/b').catch(() => undefined)
    await http.request('GET', '/c').catch(() => undefined)
    expect(h.onAuthFailure).toHaveBeenCalledTimes(2)
  })
})

describe('late 401 (token already refreshed by someone else)', () => {
  it('resends with the new token without a second refresh', async () => {
    const slow = deferred()
    const h = harness([() => slow.promise, json(200, { ok: true })])
    const onUnauthorized = vi.fn(async () => true)
    const pending = h.make(onUnauthorized).request('GET', '/slow')
    await Promise.resolve()
    h.setToken('new')
    slow.release(json(401, {}))
    expect(await pending).toEqual({ ok: true })
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(calls(h.fetchImpl).map(authHeader)).toEqual(['Bearer old', 'Bearer new'])
  })

  it('does not refresh or log out when the user logged out meanwhile', async () => {
    const slow = deferred()
    const h = harness([() => slow.promise])
    const onUnauthorized = vi.fn(async () => true)
    const pending = h.make(onUnauthorized).request('GET', '/slow')
    await Promise.resolve()
    h.setToken(null)
    slow.release(json(401, {}))
    await expect(pending).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(h.onAuthFailure).not.toHaveBeenCalled()
  })

  it('never sends one request more than twice (no refresh after a late-401 resend)', async () => {
    const slow = deferred()
    const h = harness([() => slow.promise, json(401, {}), json(200, { ok: 1 })])
    const onUnauthorized = vi.fn(async () => true)
    const pending = h.make(onUnauthorized).request('GET', '/slow')
    await Promise.resolve()
    h.setToken('new')
    slow.release(json(401, {}))
    await expect(pending).rejects.toMatchObject({ status: 401 })
    expect(h.fetchImpl).toHaveBeenCalledTimes(2)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})

describe('refresh outcomes', () => {
  const run = async (outcome: Outcome) => {
    const h = harness([json(401, { detail: 'orig' }), json(200, { ok: true })])
    const http = h.make(async () => outcome)
    const result = await http.request('GET', '/x').catch((e: unknown) => e)
    return { h, result }
  }

  it.each([true, 'refreshed'] as const)('%s resends once and succeeds', async (outcome) => {
    const { h, result } = await run(outcome)
    expect(result).toEqual({ ok: true })
    expect(h.fetchImpl).toHaveBeenCalledTimes(2)
    expect(h.onAuthFailure).not.toHaveBeenCalled()
  })

  it.each([false, 'rejected'] as const)('%s logs out once with the failed token', async (outcome) => {
    const { h, result } = await run(outcome)
    expect(result).toMatchObject({ status: 401 })
    expect(h.onAuthFailure).toHaveBeenCalledTimes(1)
    expect(h.onAuthFailure).toHaveBeenCalledWith('old')
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['unavailable', 'stale'] as const)('%s keeps the session and returns the original 401', async (outcome) => {
    const { h, result } = await run(outcome)
    expect(result).toMatchObject({ kind: 'http', status: 401, body: { detail: 'orig' } })
    expect(h.onAuthFailure).not.toHaveBeenCalled()
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('logs out when a freshly refreshed token is rejected too, after exactly two sends', async () => {
    const h = harness([json(401, {}), json(401, {})])
    const http = h.make(async () => {
      h.setToken('fresh')
      return 'refreshed'
    })
    await expect(http.request('GET', '/x')).rejects.toMatchObject({ status: 401 })
    expect(h.fetchImpl).toHaveBeenCalledTimes(2)
    expect(h.onAuthFailure).toHaveBeenCalledWith('fresh')
  })

  it('cancels the body of the discarded first 401', async () => {
    const first = json(401, { detail: 'x' })
    const cancel = vi.spyOn(first.body as ReadableStream, 'cancel')
    const h = harness([first, json(200, {})])
    await h.make(async () => 'refreshed').request('GET', '/x')
    expect(cancel).toHaveBeenCalled()
  })
})

describe('explicit bearer', () => {
  it('uses the given token, never refreshes and never reports a logout', async () => {
    const h = harness([json(401, {})])
    const onUnauthorized = vi.fn(async () => true)
    await expect(
      h.make(onUnauthorized).request('POST', '/auth/logout', { body: {}, bearer: 'explicit' }),
    ).rejects.toMatchObject({ status: 401 })
    expect(authHeader(calls(h.fetchImpl)[0])).toBe('Bearer explicit')
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(h.onAuthFailure).not.toHaveBeenCalled()
  })
})

describe('AbortSignal', () => {
  it('passes a signal to fetch', async () => {
    const h = harness([json(200, {})])
    const controller = new AbortController()
    await h.make().request('GET', '/x', { signal: controller.signal })
    expect(calls(h.fetchImpl)[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('reports an aborted request as kind=abort, not network', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })
    const http = createHttpClient({ baseUrl: '', fetchImpl })
    const error = await http.request('GET', '/x', { signal: controller.signal }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'abort', status: 0 })
  })

  it('treats a plain AbortError as abort even without a signal', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError')
    })
    await expect(createHttpClient({ baseUrl: '', fetchImpl }).request('GET', '/x')).rejects.toMatchObject({
      kind: 'abort',
    })
  })

  it('does not resend after the signal was aborted during refresh', async () => {
    const controller = new AbortController()
    const h = harness([json(401, {}), json(200, {})])
    const http = h.make(async () => {
      controller.abort()
      return 'refreshed'
    })
    await expect(http.request('GET', '/x', { signal: controller.signal })).rejects.toMatchObject({
      kind: 'abort',
    })
    expect(h.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps the plain network error kind', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(createHttpClient({ baseUrl: '', fetchImpl }).request('GET', '/x')).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('an already aborted signal never reaches the network', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}))
    const controller = new AbortController()
    controller.abort()
    await expect(
      createHttpClient({ baseUrl: '', fetchImpl }).request('GET', '/x', { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'abort' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('body reading', () => {
  const brokenBody = (status: number) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('terminated'))
        },
      }),
      { status },
    )

  it('does not turn a truncated 2xx body into a successful null', async () => {
    const fetchImpl = vi.fn(async () => brokenBody(200))
    await expect(createHttpClient({ baseUrl: '', fetchImpl }).request('GET', '/x')).rejects.toMatchObject({
      kind: 'network',
    })
  })

  it('keeps the HTTP status when an error body cannot be read', async () => {
    const fetchImpl = vi.fn(async () => brokenBody(503))
    await expect(createHttpClient({ baseUrl: '', fetchImpl }).request('GET', '/x')).rejects.toMatchObject({
      kind: 'http',
      status: 503,
      body: null,
    })
  })

  it('reports an abort while reading the body as abort', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              controller.abort()
              c.error(new DOMException('Aborted', 'AbortError'))
            },
          }),
        ),
    )
    await expect(
      createHttpClient({ baseUrl: '', fetchImpl }).request('GET', '/x', { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'abort' })
  })
})

describe('timeout', () => {
  const hanging = vi.fn((_url: string, init: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })
  }) as unknown as typeof fetch

  it('aborts a hanging request with kind=timeout', async () => {
    const http = createHttpClient({ baseUrl: '', fetchImpl: hanging, timeoutMs: 20 })
    await expect(http.request('GET', '/x')).rejects.toMatchObject({ kind: 'timeout', status: 0 })
  })

  it('a per-request timeout overrides the default', async () => {
    const http = createHttpClient({ baseUrl: '', fetchImpl: hanging })
    await expect(http.request('GET', '/x', { timeoutMs: 15 })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('a user abort stays kind=abort and reaches fetch through the combined signal', async () => {
    const http = createHttpClient({ baseUrl: '', fetchImpl: hanging, timeoutMs: 5000 })
    const controller = new AbortController()
    const pending = http.request('GET', '/x', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'abort' })
  })
})

describe('http basics', () => {
  it('sends bearer token and JSON body', async () => {
    const h = harness([json(201, { id: '1' })])
    await h.make().request('POST', '/admin/zones', { body: { name: 'A' } })
    const [url, init] = calls(h.fetchImpl)[0]
    expect(url).toBe('/api/v1/admin/zones')
    expect(init.body).toBe('{"name":"A"}')
    expect(authHeader(calls(h.fetchImpl)[0])).toBe('Bearer old')
  })

  it('omits Authorization without a token', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}))
    await createHttpClient({ baseUrl: '', fetchImpl }).request('GET', '/x')
    expect(authHeader(calls(fetchImpl)[0])).toBeUndefined()
  })

  it('returns null for empty 204 bodies', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    expect(await createHttpClient({ baseUrl: '', fetchImpl }).request('DELETE', '/x')).toBeNull()
  })

  it('throws kind=http ApiError with the parsed body', async () => {
    const fetchImpl = vi.fn(async () => json(400, { name: ['bad'] }))
    const error = await createHttpClient({ baseUrl: '', fetchImpl })
      .request('GET', '/x')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ kind: 'http', status: 400, body: { name: ['bad'] } })
  })

  it('does not crash on an HTML 502 and reports non-JSON 200 as parse', async () => {
    const bad = vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 }))
    await expect(createHttpClient({ baseUrl: '', fetchImpl: bad }).request('GET', '/x')).rejects.toMatchObject({
      kind: 'http',
      status: 502,
      body: null,
    })
    const html = vi.fn(async () => new Response('<html>login</html>', { status: 200 }))
    await expect(createHttpClient({ baseUrl: '', fetchImpl: html }).request('GET', '/x')).rejects.toMatchObject({
      kind: 'parse',
    })
  })

  it('buildQuery skips empty values and encodes the rest', () => {
    expect(buildQuery({ page: 2, search: '', status: undefined, q: 'a b' })).toBe('?page=2&q=a+b')
    expect(buildQuery(undefined)).toBe('')
  })

  it('does not try to refresh without a hook', async () => {
    const fetchImpl = vi.fn(async () => json(401, {}))
    await expect(createHttpClient({ baseUrl: '', fetchImpl }).request('GET', '/x')).rejects.toMatchObject({
      status: 401,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
