import {
  createAdminApi,
  createAuthApi,
  createHttpClient,
  type TokenProvider,
} from '@habi/api-client'

// The access token lives in memory only (never localStorage: XSS-readable). The session
// (AuthProvider) wires itself in through the accessors and hooks below:
//   - setAccessToken(token) after sign-in / refresh;
//   - hooks.onUnauthorized refreshes once (shared by parallel requests) and says whether the
//     failed request can be resent, the session is over, or nothing is known (kept signed in);
//   - hooks.onAuthFailure logs the user out locally when the server rejected the session.
// The backend enforces all permissions regardless of what the UI shows.
export type AuthHooks = Pick<TokenProvider, 'onUnauthorized' | 'onAuthFailure'>

let accessToken: string | null = null
let hooks: AuthHooks = {}

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

export function setAuthHooks(next: AuthHooks): void {
  hooks = next
}

/** Install hooks; the returned cleanup removes them only if they are still the active ones. */
export function installAuthHooks(next: AuthHooks): () => void {
  hooks = next
  return () => {
    if (hooks === next) hooks = {}
  }
}

const baseUrl = import.meta.env.VITE_API_URL ?? '/api/v1'

const http = createHttpClient({
  baseUrl,
  getToken: () => accessToken,
  // Without a session controller nothing is known, so nobody is logged out.
  onUnauthorized: () => hooks.onUnauthorized?.() ?? Promise.resolve('unavailable'),
  onAuthFailure: (token) => hooks.onAuthFailure?.(token),
})

export const adminApi = createAdminApi(http)
export const authApi = createAuthApi(http)
