import { describe, expect, it } from 'vitest'
import { refundErrorLabel } from './refundErrors'

const t = ((key: string) => key) as never

describe('refundErrorLabel', () => {
  it('translates known codes and groups', () => {
    expect(refundErrorLabel('error', t)).toBe('refunds.errorCodes.error')
    expect(refundErrorLabel('unknown_error', t)).toBe('refunds.errorCodes.unknown_error')
    expect(refundErrorLabel('retries_exhausted', t)).toBe('refunds.errorCodes.retries_exhausted')
    expect(refundErrorLabel('operator_failed', t)).toBe('refunds.errorCodes.operator_failed')
    expect(refundErrorLabel('click_error_-5', t)).toBe('refunds.errorCodes.click_error')
    expect(refundErrorLabel('http_502', t)).toBe('refunds.errorCodes.http_error')
  })

  it('falls back to plain sanitised text, and a dash when empty', () => {
    expect(refundErrorLabel('weird_code', t)).toBe('weird_code')
    expect(refundErrorLabel('', t)).toBe('—')
    expect(refundErrorLabel(undefined, t)).toBe('—')
  })
})
