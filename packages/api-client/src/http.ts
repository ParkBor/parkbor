export type ApiErrorKind = 'network' | 'http' | 'parse' | 'abort' | 'timeout'

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown
  readonly kind: ApiErrorKind

  constructor(status: number, body: unknown, kind: ApiErrorKind = 'http') {
    super(`API error (${kind}) ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.kind = kind
  }
}

/**
 * What a refresh attempt concluded:
 *  - refreshed:   a new token is stored, resend the request;
 *  - rejected:    the server refused the refresh token, the session is over (log out);
 *  - unavailable: could not find out (network, 5xx, 429, bad body): keep the session;
 *  - stale:       the session changed while waiting (logout / new login): do nothing.
 * Plain booleans are accepted too: true = refreshed, false = rejected.
 */
export type RefreshOutcome = 'refreshed' | 'rejected' | 'unavailable' | 'stale'

/**
 * Token provider contract: supply the in-memory access token (getToken), a single-flight
 * refresh (onUnauthorized) and a logout callback (onAuthFailure) that receives the access token
 * that was rejected, so the app can ignore reports about a token it no longer uses.
 */
export interface TokenProvider {
  getToken?: () => string | null | undefined
  onUnauthorized?: () => Promise<boolean | RefreshOutcome>
  onAuthFailure?: (rejectedToken?: string | null) => void
}

export interface HttpClientOptions extends TokenProvider {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** Per-attempt deadline including the response body; 0 disables it. */
  timeoutMs?: number
}

export interface HttpClient {
  request<T>(method: string, path: string, options?: RequestOptions): Promise<T>
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>
  body?: unknown
  /** Cancels the request; the resulting error has kind='abort'. */
  signal?: AbortSignal
  /** Overrides the client's default deadline for this request. */
  timeoutMs?: number
  /**
   * Use exactly this access token (e.g. to revoke a session after it was cleared locally).
   * Such a request never refreshes and never reports a logout.
   */
  bearer?: string
}

export const DEFAULT_TIMEOUT_MS = 30_000

// Credential endpoints: a 401 here means "wrong credentials", never "access token expired".
// They must not trigger refresh/logout (a failing refresh would otherwise wait on itself).
// /auth/logout is NOT listed: it needs the Bearer token like any authenticated call.
const AUTH_PATH_PREFIXES = ['/auth/telegram/']
const AUTH_PATHS = ['/auth/token/refresh']
const MAX_DECODE_ROUNDS = 3

/** Canonical form used only for classification: decoded, lowercase, dot-segments resolved. */
function normalizePath(path: string): string {
  let value = path.split(/[?#]/)[0]
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) break
      value = decoded
    } catch {
      break
    }
  }
  const segments: string[] = []
  for (const segment of value.replace(/\\/g, '/').toLowerCase().split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

export function isAuthEndpoint(path: string): boolean {
  const normalized = normalizePath(path)
  return (
    AUTH_PATHS.includes(normalized) || AUTH_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  )
}

export function buildQuery(query: RequestOptions['query']): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

/** Combines the caller's signal with a deadline; dispose() must run when the attempt is over. */
interface Deadline {
  signal: AbortSignal
  didTimeout: () => boolean
  dispose: () => void
}

function createDeadline(user: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController()
  let timedOut = false
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort(new DOMException('Request timed out', 'TimeoutError'))
        }, timeoutMs)
      : null
  const onUserAbort = () => controller.abort(user?.reason)
  if (user?.aborted) controller.abort(user.reason)
  else user?.addEventListener('abort', onUserAbort, { once: true })
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      if (timer !== null) clearTimeout(timer)
      user?.removeEventListener('abort', onUserAbort)
    },
  }
}

function errorName(cause: unknown): string | undefined {
  return typeof cause === 'object' && cause !== null ? (cause as { name?: string }).name : undefined
}

function classify(cause: unknown, user: AbortSignal | undefined, deadline: Deadline): ApiErrorKind {
  if (user?.aborted) return 'abort'
  if (deadline.didTimeout() || errorName(cause) === 'TimeoutError') return 'timeout'
  if (errorName(cause) === 'AbortError') return 'abort'
  return 'network'
}

interface Attempt {
  response: Response
  /** The access token this attempt was sent with (null = anonymous). */
  token: string | null
  req: RequestOptions
  deadline: Deadline
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const currentToken = (): string | null => options.getToken?.() ?? null
  // One refresh at a time: parallel 401s wait for the same promise.
  let refreshing: Promise<RefreshOutcome> | null = null
  // onAuthFailure fires once per failed session: parallel requests sent with the same token
  // share one notification. Cleared as soon as a request goes out with a different token.
  let notified: { token: string | null } | null = null

  function refreshOnce(): Promise<RefreshOutcome> {
    const hook = options.onUnauthorized
    if (!hook) return Promise.resolve('unavailable')
    if (!refreshing) {
      refreshing = hook()
        .then((result): RefreshOutcome => {
          if (result === true) return 'refreshed'
          if (result === false) return 'rejected'
          return result
        })
        .catch((): RefreshOutcome => 'unavailable') // a crashing hook is not a logout
        .finally(() => {
          refreshing = null
        })
    }
    return refreshing
  }

  function notifyAuthFailure(token: string | null): void {
    if (notified && notified.token === token) return
    notified = { token }
    options.onAuthFailure?.(token)
  }

  async function send(method: string, path: string, req: RequestOptions): Promise<Attempt> {
    if (req.signal?.aborted) throw new ApiError(0, 'Request aborted', 'abort')
    const headers: Record<string, string> = { Accept: 'application/json' }
    const token = req.bearer ?? (isAuthEndpoint(path) ? null : currentToken())
    if (req.bearer === undefined && notified && notified.token !== token) notified = null
    if (token) headers.Authorization = `Bearer ${token}`
    if (req.body !== undefined) headers['Content-Type'] = 'application/json'
    const deadline = createDeadline(req.signal, req.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await doFetch(`${options.baseUrl}${path}${buildQuery(req.query)}`, {
        method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: deadline.signal,
      })
      return { response, token, req, deadline }
    } catch (cause) {
      const kind = classify(cause, req.signal, deadline)
      deadline.dispose()
      throw new ApiError(0, cause instanceof Error ? cause.message : null, kind)
    }
  }

  function discard(attempt: Attempt): void {
    void attempt.response.body?.cancel().catch(() => undefined)
    attempt.deadline.dispose()
  }

  async function read<T>(attempt: Attempt): Promise<T> {
    const { response, req, deadline } = attempt
    let text: string
    try {
      text = await response.text()
    } catch (cause) {
      const kind = classify(cause, req.signal, deadline)
      const message = cause instanceof Error ? cause.message : null
      if (kind === 'abort' || kind === 'timeout') throw new ApiError(0, message, kind)
      // A cut-off 2xx body is a failure, never an empty success; an error status stays an error.
      if (response.ok) throw new ApiError(0, message, 'network')
      throw new ApiError(response.status, null, 'http')
    } finally {
      deadline.dispose()
    }
    const parsed = text ? tryParse(text) : ({ ok: true, value: null } as const)
    if (!response.ok) throw new ApiError(response.status, parsed.ok ? parsed.value : null, 'http')
    if (!parsed.ok) throw new ApiError(response.status, null, 'parse')
    return parsed.value as T
  }

  /**
   * Handle a 401. At most ONE more request is ever sent: either with a token somebody else
   * already refreshed, or after our own refresh.
   */
  async function recover(method: string, path: string, req: RequestOptions, first: Attempt): Promise<Attempt> {
    const now = currentToken()
    if (now !== first.token) {
      if (!now) return first // logged out meanwhile: nothing to refresh
      discard(first)
      return send(method, path, req)
    }
    const outcome = await refreshOnce()
    if (req.signal?.aborted) {
      discard(first)
      throw new ApiError(0, 'Request aborted', 'abort')
    }
    if (outcome === 'refreshed') {
      discard(first)
      const second = await send(method, path, req)
      if (second.response.status === 401) notifyAuthFailure(second.token)
      return second
    }
    if (outcome === 'rejected') notifyAuthFailure(first.token)
    return first
  }

  return {
    async request<T>(method: string, path: string, req: RequestOptions = {}): Promise<T> {
      let attempt = await send(method, path, req)
      const canRecover =
        attempt.response.status === 401 &&
        req.bearer === undefined &&
        options.onUnauthorized !== undefined &&
        !isAuthEndpoint(path)
      if (canRecover) attempt = await recover(method, path, req, attempt)
      return read<T>(attempt)
    },
  }
}
