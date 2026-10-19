import type { TFunction } from 'i18next'
import { safeText } from './format'

const KNOWN = ['error', 'unknown_error', 'retries_exhausted', 'operator_failed']

/**
 * Last refund error for the table: a machine code for ADMIN, the generic `error` for OWNER.
 * Known codes are translated; click_error_* and http_* groups too; anything else is plain text.
 */
export function refundErrorLabel(code: unknown, t: TFunction): string {
  const text = safeText(code, 40)
  if (!text) return '—'
  if (KNOWN.includes(text)) return t(`refunds.errorCodes.${text}`)
  if (text.startsWith('click_error')) return t('refunds.errorCodes.click_error')
  if (text.startsWith('http_')) return t('refunds.errorCodes.http_error')
  return text
}
