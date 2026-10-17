import { ApiError, type HttpClient, type RequestOptions } from './http'

export type UserRole = 'DRIVER' | 'OPERATOR' | 'OWNER' | 'ADMIN'

export interface AuthUser {
  id: string
  telegram_id: number
  telegram_username: string
  phone: string | null
  first_name: string
  last_name: string
  language: string
  role: UserRole
  tg_notifications: boolean
}

/**
 * What the Telegram Login Widget hands to data-onauth. The HMAC covers EVERY field the widget
 * returned (including ones added in the future), so pass the object on unchanged.
 */
export interface TelegramWidgetPayload {
  id: number
  auth_date: number
  hash: string
  first_name?: string
  last_name?: string
  username?: string
  photo_url?: string
  [extra: string]: string | number | undefined
}

export interface AuthResponse {
  access: string
  refresh: string
  user: AuthUser
  is_new: boolean
}

export interface TokenPair {
  access: string
  /** Refresh tokens rotate: the previous one is blacklisted by the server. */
  refresh: string
}

export type AuthCallOptions = Pick<RequestOptions, 'signal' | 'timeoutMs' | 'bearer'>

function hasTokenPair(value: unknown): value is TokenPair {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return (
    typeof pair.access === 'string' &&
    pair.access.length > 0 &&
    typeof pair.refresh === 'string' &&
    pair.refresh.length > 0
  )
}

/** A 2xx without usable tokens is a broken response, not a session. */
function requireTokenPair<T>(value: T): T {
  if (!hasTokenPair(value)) throw new ApiError(200, null, 'parse')
  return value
}

export function createAuthApi(http: HttpClient) {
  return {
    loginWithTelegramWidget: async (payload: TelegramWidgetPayload, options: AuthCallOptions = {}) =>
      requireTokenPair(
        await http.request<AuthResponse>('POST', '/auth/telegram/widget', { body: payload, ...options }),
      ),
    refreshTokens: async (refresh: string, options: AuthCallOptions = {}) =>
      requireTokenPair(
        await http.request<TokenPair>('POST', '/auth/token/refresh', { body: { refresh }, ...options }),
      ),
    logout: (refresh: string, options: AuthCallOptions = {}) =>
      http.request<null>('POST', '/auth/logout', { body: { refresh }, ...options }),
    getMe: (options: AuthCallOptions = {}) => http.request<AuthUser>('GET', '/me', options),
  }
}

export type AuthApi = ReturnType<typeof createAuthApi>
