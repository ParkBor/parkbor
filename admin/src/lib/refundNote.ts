import type { AdminRefund, RefundOutcome } from '@habi/api-client'

// Mirrors backend payments.refunds.clean_note: the note lands in the booking history and the
// audit log, so it must not carry a phone or card number. The server stays the authority.
export const REFUND_NOTE_MAX = 200
const SQUEEZE = /[\s.\-()]/g
const LONG_DIGITS = /\d{9,}/
const PLUS_DIGIT = /\+\s*\d/
/** The `last_error` the backend sets when an operator gave up on a refund: it is final. */
export const OPERATOR_FAILED = 'operator_failed'

export type NoteProblem = 'tooLong' | 'sensitive' | null

export function checkRefundNote(note: string): NoteProblem {
  const trimmed = note.trim()
  if (trimmed.length > REFUND_NOTE_MAX) return 'tooLong'
  if (LONG_DIGITS.test(trimmed.replace(SQUEEZE, '')) || PLUS_DIGIT.test(trimmed)) return 'sensitive'
  return null
}

/** Outcomes an operator may choose for a refund (docs 8.4 "OPERATOR YO'RIQNOMASI"). */
export function allowedOutcomes(refund: Pick<AdminRefund, 'status' | 'last_error'>): RefundOutcome[] {
  if (refund.status === 'MANUAL') return ['done', 'failed']
  if (refund.status === 'FAILED') {
    if (refund.last_error === OPERATOR_FAILED) return [] // final: money went back to the payment
    return ['done', 'retry']
  }
  return [] // PENDING / SENT / DONE are never touched by hand
}
