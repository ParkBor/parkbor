import { ApiError } from '@habi/api-client'
import { safeText } from './format'

export interface ParsedApiError {
  /** Messages per backend field name (DRF {field: [msgs]}). */
  fields: Record<string, string[]>
  /** Message not tied to a field ({detail}, non_field_errors, bare string/list). */
  general: string | null
}

const GENERAL_KEYS = new Set(['detail', 'non_field_errors'])
const IGNORED_KEYS = new Set(['code'])
const MAX_DEPTH = 6
const MAX_ERROR_TEXT = 300

/** Collect every string inside an arbitrarily nested DRF error value. */
function flatten(value: unknown, depth = 0): string[] {
  if (depth > MAX_DEPTH || value === null || value === undefined) return []
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (Array.isArray(value)) return value.flatMap((item) => flatten(item, depth + 1))
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      flatten(item, depth + 1),
    )
  }
  return []
}

export function parseApiError(error: unknown): ParsedApiError {
  const empty: ParsedApiError = { fields: {}, general: null }
  if (!(error instanceof ApiError) || error.kind !== 'http') return empty
  const body = error.body
  if (body === null || body === undefined) return empty
  if (typeof body !== 'object' || Array.isArray(body)) {
    const text = flatten(body).join(' ')
    return { fields: {}, general: text || null }
  }
  // Null prototype: backend keys like "__proto__"/"constructor" must stay plain data.
  const fields: Record<string, string[]> = Object.create(null) as Record<string, string[]>
  const general: string[] = []
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (IGNORED_KEYS.has(key)) continue
    const messages = flatten(value)
    if (messages.length === 0) continue
    if (GENERAL_KEYS.has(key)) general.push(...messages)
    else fields[key] = messages
  }
  return { fields, general: general.length > 0 ? general.join(' ') : null }
}

/**
 * One readable line for toasts/alerts. Only 400 validation messages (what the user can fix) are
 * shown; for every other failure the caller's translated fallback is used, so internal server
 * text never reaches the screen.
 */
export function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError) || error.status !== 400) return fallback
  const { fields, general } = parseApiError(error)
  const parts = [
    ...(general ? [general] : []),
    ...Object.entries(fields).map(([key, messages]) => `${key}: ${messages.join(' ')}`),
  ]
  return parts.length > 0 ? safeText(parts.join('; '), MAX_ERROR_TEXT) : fallback
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

/** The machine `code` of a `{detail, code}` error body, if the server sent one. */
export function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.kind !== 'http') return null
  const body = error.body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const code = (body as Record<string, unknown>).code
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : null
}

function errorBody(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError) || error.kind !== 'http') return null
  const body = error.body
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/**
 * The backend does not serve this URL (yet): 405/501, or a 404 WITHOUT a DRF JSON body. A 404 that
 * carries `{detail}`/`{code}` is the API answering "no such object / page", not a missing route.
 */
export function isEndpointMissing(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.kind !== 'http') return false
  if (error.status === 405 || error.status === 501) return true
  if (error.status !== 404) return false
  const body = errorBody(error)
  return body === null || (typeof body.detail !== 'string' && typeof body.code !== 'string')
}

/** DRF answered 404 "Invalid page." (the requested page is beyond the last one). */
export function isPageOutOfRange(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 404) return false
  const body = errorBody(error)
  if (body === null) return false
  return body.code === 'invalid_page' || (typeof body.detail === 'string' && /invalid page/i.test(body.detail))
}
