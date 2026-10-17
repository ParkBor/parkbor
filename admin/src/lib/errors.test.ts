import { ApiError } from '@habi/api-client'
import { describe, expect, it } from 'vitest'
import { describeError, parseApiError } from './errors'

const http = (body: unknown, status = 400) => new ApiError(status, body, 'http')

describe('parseApiError', () => {
  it('splits DRF field errors', () => {
    const parsed = parseApiError(http({ name: ['Required.', 'Too short.'], lat: ['Bad'] }))
    expect(parsed.fields).toEqual({ name: ['Required.', 'Too short.'], lat: ['Bad'] })
    expect(parsed.general).toBeNull()
  })

  it('treats {detail, code} as a general message', () => {
    const parsed = parseApiError(http({ detail: 'Conflict here', code: 'conflict' }, 409))
    expect(parsed.general).toBe('Conflict here')
    expect(parsed.fields).toEqual({})
  })

  it('flattens nested objects without printing [object Object]', () => {
    const parsed = parseApiError(
      http({ rules: { coefficients: [{ coefficient: ['Too big'] }, 'Overlap'] } }),
    )
    expect(parsed.fields.rules).toEqual(['Too big', 'Overlap'])
    expect(JSON.stringify(parsed)).not.toContain('[object Object]')
  })

  it('puts non_field_errors into the general message', () => {
    expect(parseApiError(http({ non_field_errors: ['Nope'] })).general).toBe('Nope')
  })

  it('handles a bare list or string body', () => {
    expect(parseApiError(http(['a', 'b'])).general).toBe('a b')
    expect(parseApiError(http('plain')).general).toBe('plain')
  })

  it('returns empty for non-http errors and unknown values', () => {
    expect(parseApiError(new Error('x'))).toEqual({ fields: {}, general: null })
    expect(parseApiError(new ApiError(0, null, 'network'))).toEqual({ fields: {}, general: null })
    expect(parseApiError(http(null, 502))).toEqual({ fields: {}, general: null })
  })
})

describe('describeError', () => {
  it('joins field and general messages', () => {
    expect(describeError(http({ name: ['Bad'], detail: 'Oops' }), 'fallback')).toBe(
      'Oops; name: Bad',
    )
  })

  it.each([401, 403, 404, 409, 500, 502])(
    'never shows raw server text for status %i (only validation errors are shown)',
    (status) => {
      expect(describeError(http({ detail: 'SECRET internal text' }, status), 'fallback')).toBe('fallback')
    },
  )

  it('falls back for network and parse errors', () => {
    expect(describeError(new ApiError(0, null, 'network'), 'fallback')).toBe('fallback')
    expect(describeError('weird', 'fallback')).toBe('fallback')
  })
})

describe('prototype-pollution-like keys', () => {
  it('keeps __proto__ and constructor as plain field names', () => {
    const body = JSON.parse('{"__proto__": ["bad"], "constructor": ["worse"], "name": ["x"]}') as unknown
    const parsed = parseApiError(http(body))
    expect(Object.getPrototypeOf(parsed.fields)).toBeNull()
    expect(Object.hasOwn(parsed.fields, '__proto__')).toBe(true)
    expect(parsed.fields.constructor).toEqual(['worse'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('describeError mentions such keys without throwing', () => {
    const body = JSON.parse('{"__proto__": ["bad"]}') as unknown
    expect(describeError(http(body), 'fallback')).toBe('__proto__: bad')
  })
})
