import { ApiError } from '@habi/api-client'
import { SessionSupersededError } from './auth'

export const DEFAULT_REDIRECT = '/dashboard'

/** Every i18n key a failed sign-in can show (checked against uz/ru/en in the tests). */
export const AUTH_ERROR_KEYS = [
  'auth.errors.botNotConfigured',
  'auth.errors.widgetLoad',
  'auth.errors.invalidWidget',
  'auth.errors.noRole',
  'auth.errors.accountDisabled',
  'auth.errors.tooMany',
  'auth.errors.network',
  'auth.errors.unknown',
] as const

export type AuthErrorKey = (typeof AUTH_ERROR_KEYS)[number]

function bodyCode(error: ApiError): string | null {
  const body = error.body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const code = (body as Record<string, unknown>).code
  return typeof code === 'string' ? code : null
}

/**
 * i18n key for a failed Telegram-widget sign-in, or null when nothing should be shown (aborted
 * or overtaken). Only fixed translated texts are returned: raw server messages are never shown.
 */
export function loginErrorKey(error: unknown): AuthErrorKey | null {
  if (error instanceof SessionSupersededError) return null
  if (!(error instanceof ApiError)) return 'auth.errors.unknown'
  if (error.kind === 'abort') return null
  if (error.kind === 'network' || error.kind === 'timeout') return 'auth.errors.network'
  if (error.kind !== 'http') return 'auth.errors.unknown'
  if (error.status === 400) return 'auth.errors.invalidWidget'
  if (error.status === 403) {
    return bodyCode(error) === 'account_disabled' ? 'auth.errors.accountDisabled' : 'auth.errors.noRole'
  }
  if (error.status === 429) return 'auth.errors.tooMany'
  return 'auth.errors.unknown'
}

// Control characters (incl. \t \n \r that URL parsers silently strip) and backslashes.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/

function decodedLower(path: string): string {
  try {
    return decodeURIComponent(path).toLowerCase()
  } catch {
    return path.toLowerCase()
  }
}

/** Post-login destination from router state; anything that is not a plain in-app path is dropped. */
export function safeRedirectTarget(from: unknown): string {
  if (typeof from !== 'object' || from === null) return DEFAULT_REDIRECT
  const { pathname, search = '', hash = '' } = from as Record<string, unknown>
  if (typeof pathname !== 'string' || typeof search !== 'string' || typeof hash !== 'string') {
    return DEFAULT_REDIRECT
  }
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return DEFAULT_REDIRECT
  if (search !== '' && !search.startsWith('?')) return DEFAULT_REDIRECT
  if (hash !== '' && !hash.startsWith('#')) return DEFAULT_REDIRECT
  if ([pathname, search, hash].some((part) => FORBIDDEN_CHARS.test(part))) return DEFAULT_REDIRECT
  try {
    // The URL parser is the final judge. Every check runs on its NORMALISED pathname, so
    // "/.//evil.com" or "/a/..//evil.com" (which collapse to "//evil.com") cannot slip through.
    const base = 'http://app.invalid'
    const url = new URL(`${pathname}${search}${hash}`, base)
    if (url.origin !== base) return DEFAULT_REDIRECT
    if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return DEFAULT_REDIRECT
    const lowered = decodedLower(url.pathname)
    if (lowered === '/login' || lowered.startsWith('/login/')) return DEFAULT_REDIRECT
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return DEFAULT_REDIRECT
  }
}
