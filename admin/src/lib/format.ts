// Display helpers. Money is a decimal STRING end to end: digits are grouped and compared with
// string / BigInt operations only, never through Number (floats lose cents on large sums).

import { LINE_BREAKS, UNSAFE_EXCEPT_NEWLINE, UNSAFE_TEXT } from './unsafeChars'

export const DASH = '—'
export const TASHKENT_TZ = 'Asia/Tashkent'
const MAX_TEXT_LENGTH = 500
const MONEY_PATTERN = /^-?\d{1,18}(\.\d{1,2})?$/
const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,4})?$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PERCENT_SCALE = 100n
const MINOR_PER_UNIT = 100n

const LOCALES: Record<string, string> = { uz: 'uz-UZ', ru: 'ru-RU', en: 'en-GB' }

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/** Server text -> display text: no control / bidi / zero-width characters, bounded length. */
export function safeText(value: unknown, max = MAX_TEXT_LENGTH): string {
  if (value === null || value === undefined) return ''
  // Line breaks and tabs become one space (words must not glue together); other controls go.
  const text = String(value).replace(LINE_BREAKS, ' ').replace(UNSAFE_TEXT, '')
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

export function isMoney(value: unknown): value is string {
  return typeof value === 'string' && MONEY_PATTERN.test(value)
}

/** "1234567.50" -> "1 234 567.50", "12000.00" -> "12 000". Invalid input -> a dash. */
export function formatMoney(value: string | null | undefined): string {
  if (!isMoney(value)) return DASH
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = value.replace('-', '').split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const cents = /^0*$/.test(fraction) ? '' : `.${fraction}`
  return `${negative ? '-' : ''}${grouped}${cents}`
}

/** Exact integer minor units (tiyin) of a money string, or null if it is not money. */
export function moneyToMinor(value: string | null | undefined): bigint | null {
  if (!isMoney(value)) return null
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = value.replace('-', '').split('.')
  const minor = BigInt(whole) * MINOR_PER_UNIT + BigInt(fraction.padEnd(2, '0') || '0')
  return negative ? -minor : minor
}

/** Width (0..100) of a bar for `value` against `max`, using integer maths only. */
export function barPercent(value: string, max: string): number {
  const v = moneyToMinor(value)
  const m = moneyToMinor(max)
  if (v === null || m === null || m <= 0n || v <= 0n) return 0
  const scaled = (v * PERCENT_SCALE) / m
  return Number(scaled > PERCENT_SCALE ? PERCENT_SCALE : scaled)
}

export function formatPercent(value: string | null | undefined): string {
  if (typeof value !== 'string' || !PERCENT_PATTERN.test(value)) return DASH
  return `${value}%`
}

/** Date and time in Asia/Tashkent (the product's zone), in the UI language. */
export function formatDateTime(iso: string | null | undefined, language: string): string {
  if (!iso) return DASH
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return DASH
  return new Intl.DateTimeFormat(LOCALES[language] ?? LOCALES.en, {
    timeZone: TASHKENT_TZ,
    dateStyle: 'short',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(date)
}

/** Like safeText but keeps line breaks (pretty-printed JSON, multi-line cells). */
export function safeMultiline(value: unknown, max = MAX_TEXT_LENGTH): string {
  if (value === null || value === undefined) return ''
  const text = String(value).replace(UNSAFE_EXCEPT_NEWLINE, '')
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

/** A percentage string as a number for a progress bar (never used for money). */
export function percentValue(value: string | null | undefined): number {
  return typeof value === 'string' && PERCENT_PATTERN.test(value) ? Math.min(100, Number(value)) : 0
}

const META_MAX = 2000

/** Audit meta is scrubbed by the server; print it as inert, bounded text. */
export function metaText(meta: unknown): string {
  try {
    return safeMultiline(JSON.stringify(meta, null, 2) ?? '', META_MAX)
  } catch {
    return ''
  }
}
