import { describe, expect, it } from 'vitest'
import { allowedOutcomes, checkRefundNote } from './refundNote'

describe('checkRefundNote (mirrors the server rule)', () => {
  it('accepts an ordinary note and an empty one', () => {
    expect(checkRefundNote('Returned in the Payme cabinet, ticket 12345')).toBeNull()
    expect(checkRefundNote('')).toBeNull()
  })

  it.each(['card 8600 1234 5678 9012', 'tel 998901234567', '90-123-45-67-89', 'call +99890'])(
    'rejects phone or card like %j',
    (note) => {
      expect(checkRefundNote(note)).toBe('sensitive')
    },
  )

  it('allows short digit runs', () => {
    expect(checkRefundNote('order 12345678')).toBeNull()
  })

  it('rejects notes over 200 characters', () => {
    expect(checkRefundNote('x'.repeat(200))).toBeNull()
    expect(checkRefundNote('x'.repeat(201))).toBe('tooLong')
  })
})

describe('allowedOutcomes', () => {
  const base = { payment: 'p1', last_error: '' }
  it('MANUAL: done or failed', () => {
    expect(allowedOutcomes({ ...base, status: 'MANUAL' })).toEqual(['done', 'failed'])
  })
  it('FAILED: done or retry; retry needs a payment', () => {
    expect(allowedOutcomes({ ...base, status: 'FAILED' })).toEqual(['done', 'retry'])
    expect(allowedOutcomes({ payment: null, last_error: '', status: 'FAILED' })).toEqual(['done'])
  })
  it('an operator-failed refund is final', () => {
    expect(allowedOutcomes({ ...base, status: 'FAILED', last_error: 'operator_failed' })).toEqual([])
  })
  it.each(['PENDING', 'SENT', 'DONE'] as const)('%s cannot be resolved by hand', (status) => {
    expect(allowedOutcomes({ ...base, status })).toEqual([])
  })
})
