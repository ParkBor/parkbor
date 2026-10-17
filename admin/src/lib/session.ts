import {
  ApiError,
  type AuthApi,
  type AuthUser,
  type RefreshOutcome,
  type TelegramWidgetPayload,
} from '@habi/api-client'
import {
  type AuthHooks,
  authApi,
  getAccessToken,
  installAuthHooks,
  setAccessToken,
} from './api'
import { type RefreshTokenStore, SessionSupersededError } from './auth'

/** Everything the session needs from the outside world; tests and apps may swap it. */
export interface SessionDeps {
  api: Pick<AuthApi, 'loginWithTelegramWidget' | 'refreshTokens' | 'logout' | 'getMe'>
  accessToken: { get: () => string | null; set: (token: string | null) => void }
  installHooks: (hooks: AuthHooks) => () => void
}

export const defaultSessionDeps: SessionDeps = {
  api: authApi,
  accessToken: { get: getAccessToken, set: setAccessToken },
  installHooks: installAuthHooks,
}

export interface SessionSnapshot {
  status: 'anonymous' | 'unavailable' | 'authenticated'
  user: AuthUser | null
}

export interface SessionOptions {
  store: RefreshTokenStore
  /** Called with every state change while at least one consumer is attached. */
  onChange: (snapshot: SessionSnapshot) => void
  /** Called when a signed-in session ends; e.g. to drop cached server data. */
  onCleared?: () => void
  deps?: SessionDeps
}

const ANONYMOUS: SessionSnapshot = { status: 'anonymous', user: null }
const UNAVAILABLE: SessionSnapshot = { status: 'unavailable', user: null }
// The server refused the credential only when it says so with one of its own error codes.
// A bare 400/401/403/404/408/410/429/5xx can come from a WAF, CDN or proxy: keep the session.
const REJECTING_401_CODES = ['token_not_valid', 'invalid_token', 'user_not_found', 'user_inactive', 'no_active_account']
const REVOKE_TIMEOUT_MS = 10_000

// Server-side revocations run in the background; this only lets tests (and shutdown code)
// wait for them. It carries no session state.
const pendingRevokes = new Set<Promise<void>>()

/** Resolves once every background revocation started so far has finished. */
export async function whenRevocationsSettled(): Promise<void> {
  while (pendingRevokes.size > 0) await Promise.all([...pendingRevokes])
}

function errorCode(error: ApiError): string | null {
  const body = error.body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const code = (body as Record<string, unknown>).code
  return typeof code === 'string' ? code : null
}

/** `meCall`: for GET /me an account_disabled 403 also ends the session. */
function isRejection(error: unknown, meCall = false): boolean {
  if (!(error instanceof ApiError) || error.kind !== 'http') return false
  const code = errorCode(error)
  if (code === null) return false
  if (error.status === 401) return REJECTING_401_CODES.includes(code)
  if (error.status === 400) return code === 'invalid_token'
  return meCall && error.status === 403 && code === 'account_disabled'
}

type UserLoad = { result: 'ok' } | { result: 'stale' } | { result: 'rejected' | 'unavailable'; error: unknown }

/**
 * Session logic outside React. `epoch` counts session changes (login, logout, wipe); results of
 * work started under an older epoch are dropped ("stale") and never touch the newer session.
 * Only a server REJECTION ends a session; network trouble, 429 or 5xx keep it.
 */
export function createSession({ store, onChange, onCleared, deps = defaultSessionDeps }: SessionOptions) {
  const { api, accessToken } = deps
  let onClearedHandler = onCleared
  let epoch = 0
  let signedIn = false
  let attached = 0
  let inflight: Promise<RefreshOutcome> | null = null
  let bootstrapping: Promise<void> | null = null
  let lastRefreshed: { access: string; refresh: string } | null = null

  function emit(snapshot: SessionSnapshot): void {
    if (attached > 0) onChange(snapshot)
  }

  function wipe(): void {
    epoch += 1
    signedIn = false
    accessToken.set(null)
    store.clear()
  }

  /** Revoke a refresh token server-side, best effort. The access token is passed explicitly. */
  async function revoke(refreshToken: string, access: string | null): Promise<void> {
    if (access) {
      try {
        await api.logout(refreshToken, { bearer: access, timeoutMs: REVOKE_TIMEOUT_MS })
        return
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) return
      }
    }
    try {
      // The access token expired (or is gone): mint a pair by hand and revoke that one.
      const pair = await api.refreshTokens(refreshToken, { timeoutMs: REVOKE_TIMEOUT_MS })
      await api.logout(pair.refresh, { bearer: pair.access, timeoutMs: REVOKE_TIMEOUT_MS })
    } catch {
      // the token expires on its own
    }
  }

  function revokeInBackground(refreshToken: string, access: string | null): void {
    const task = revoke(refreshToken, access)
    pendingRevokes.add(task)
    void task.finally(() => pendingRevokes.delete(task))
  }

  /** End the session now: local state first, server revocation afterwards. */
  function terminate(): void {
    const refreshToken = store.get()
    const access = accessToken.get()
    const wasSignedIn = signedIn
    wipe()
    emit(ANONYMOUS)
    if (wasSignedIn) onClearedHandler?.()
    if (refreshToken) revokeInBackground(refreshToken, access)
  }

  /**
   * The server refused our session while we were signed in: forget it. If the refused token
   * came from a refresh we just did, the rotated refresh token is still live: revoke it.
   */
  function endRejectedSession(revokeRefreshed: { refresh: string; access: string } | null): void {
    wipe()
    emit(ANONYMOUS)
    onClearedHandler?.()
    if (revokeRefreshed) revokeInBackground(revokeRefreshed.refresh, revokeRefreshed.access)
  }

  function refresh(): Promise<RefreshOutcome> {
    if (inflight) return inflight
    const refreshToken = store.get()
    if (!refreshToken) return Promise.resolve('rejected') // no session to refresh
    const startEpoch = epoch
    inflight = api
      .refreshTokens(refreshToken)
      .then((pair): RefreshOutcome => {
        if (epoch !== startEpoch) {
          // The session changed while we waited. The server already rotated the token: revoke it.
          revokeInBackground(pair.refresh, pair.access)
          return 'stale'
        }
        accessToken.set(pair.access)
        store.set(pair.refresh)
        lastRefreshed = pair
        return 'refreshed'
      })
      .catch((error: unknown): RefreshOutcome => {
        if (epoch !== startEpoch) return 'stale'
        return isRejection(error) ? 'rejected' : 'unavailable'
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  function handleAuthFailure(rejectedToken?: string | null): void {
    if (!signedIn) return
    // A report about a token we no longer use belongs to an older session: ignore it.
    if (rejectedToken !== undefined && rejectedToken !== accessToken.get()) return
    const refreshed = lastRefreshed && lastRefreshed.access === accessToken.get() ? lastRefreshed : null
    endRejectedSession(refreshed)
  }

  async function loadUser(startEpoch: number): Promise<UserLoad> {
    try {
      const me = await api.getMe()
      if (epoch !== startEpoch) return { result: 'stale' }
      signedIn = true
      emit({ status: 'authenticated', user: me })
      return { result: 'ok' }
    } catch (error) {
      if (epoch !== startEpoch) return { result: 'stale' }
      return { result: isRejection(error, true) ? 'rejected' : 'unavailable', error }
    }
  }

  async function runBootstrap(): Promise<void> {
    if (!store.get()) {
      emit(ANONYMOUS)
      return
    }
    const startEpoch = epoch
    const outcome = await refresh()
    if (epoch !== startEpoch || outcome === 'stale') return // a login/logout took over
    if (outcome === 'rejected') {
      wipe()
      emit(ANONYMOUS)
      return
    }
    if (outcome === 'unavailable') {
      emit(UNAVAILABLE)
      return
    }
    const loaded = await loadUser(startEpoch)
    if (loaded.result === 'rejected') {
      wipe()
      emit(ANONYMOUS)
    } else if (loaded.result === 'unavailable') {
      emit(UNAVAILABLE) // tokens stay: the session may be fine, we just could not ask
    }
  }

  /** Restore a stored session once (StrictMode runs effects twice; rotation allows one use). */
  function bootstrap(): Promise<void> {
    bootstrapping ??= runBootstrap()
    return bootstrapping
  }

  function retry(): Promise<void> {
    bootstrapping = null
    return bootstrap()
  }

  async function login(payload: TelegramWidgetPayload): Promise<void> {
    if (signedIn || store.get()) terminate() // end the old session explicitly, never silently
    epoch += 1
    const startEpoch = epoch
    const result = await api.loginWithTelegramWidget(payload)
    if (epoch !== startEpoch) {
      revokeInBackground(result.refresh, result.access)
      throw new SessionSupersededError()
    }
    accessToken.set(result.access)
    store.set(result.refresh)
    const loaded = await loadUser(startEpoch) // the role comes from /me
    if (loaded.result === 'ok') return
    if (loaded.result === 'stale') throw new SessionSupersededError()
    revokeInBackground(result.refresh, result.access)
    wipe()
    emit(ANONYMOUS)
    throw loaded.error
  }

  function logout(): Promise<void> {
    terminate()
    return Promise.resolve()
  }

  /** Connect a consumer: installs the 401 hooks and lets state changes through. */
  function attach(): () => void {
    attached += 1
    const uninstall = deps.installHooks({ onUnauthorized: refresh, onAuthFailure: handleAuthFailure })
    return () => {
      attached -= 1
      uninstall()
    }
  }

  return {
    attach,
    bootstrap,
    retry,
    login,
    logout,
    setOnCleared: (next: (() => void) | undefined) => {
      onClearedHandler = next
    },
  }
}

export type Session = ReturnType<typeof createSession>
