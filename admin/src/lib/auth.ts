import type { AuthUser, TelegramWidgetPayload, UserRole } from '@habi/api-client'
import { createContext, useContext } from 'react'

/**
 * loading:      restoring a stored session;
 * unavailable:  a stored session exists but could not be checked (network / server down);
 *               it is kept, call retry();
 * anonymous:    nobody is signed in;
 * authenticated: user is set (its role comes from GET /me, never from the JWT).
 */
export type AuthStatus = 'loading' | 'unavailable' | 'anonymous' | 'authenticated'

export interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  /** Sign in with the object the Telegram Login Widget returned. Rejects with the ApiError. */
  login: (payload: TelegramWidgetPayload) => Promise<void>
  /** Ends the session locally at once and revokes it on the server in the background. */
  logout: () => Promise<void>
  /** Check a stored session again after status 'unavailable'. */
  retry: () => void
}

/** A login() that was overtaken by another login/logout before it could finish. */
export class SessionSupersededError extends Error {
  constructor() {
    super('Sign-in was superseded by another session change')
    this.name = 'SessionSupersededError'
  }
}

/** Roles allowed into the admin panel (matches the backend WIDGET_ROLES). */
export const STAFF_ROLES: readonly UserRole[] = ['OWNER', 'ADMIN']

export function isStaffRole(role: UserRole | null | undefined): boolean {
  return role !== null && role !== undefined && STAFF_ROLES.includes(role)
}

/**
 * Where the refresh token lives. DECISION: in memory only (see createMemoryRefreshStore). It is
 * never written to localStorage; moving to sessionStorage later means implementing this
 * interface, nothing else changes.
 */
export interface RefreshTokenStore {
  get: () => string | null
  set: (token: string) => void
  clear: () => void
}

export function createMemoryRefreshStore(initial: string | null = null): RefreshTokenStore {
  let token = initial
  return {
    get: () => token,
    set: (next) => {
      token = next
    },
    clear: () => {
      token = null
    },
  }
}

export const defaultRefreshStore: RefreshTokenStore = createMemoryRefreshStore()

// No default value: using auth outside an AuthProvider is a programming error, not "anonymous".
export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const auth = useContext(AuthContext)
  if (auth === null) throw new Error('useAuth must be used inside <AuthProvider>')
  return auth
}

/** Role of the signed-in user (a UI hint; the API enforces permissions), else null. */
export function useRole(): UserRole | null {
  return useAuth().user?.role ?? null
}
