import { ApiError } from '@habi/api-client'
import { describe, expect, it } from 'vitest'
import { apiErrorCode, describeError, isEndpointMissing, isPageOutOfRange, parseApiError } from './errors'

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

describe('apiErrorCode / isEndpointMissing', () => {
  it('reads a well-formed machine code only', () => {
    expect(apiErrorCode(http({ detail: 'x', code: 'reservation_mismatch' }, 409))).toBe(
      'reservation_mismatch',
    )
    expect(apiErrorCode(http({ code: '<script>' }, 409))).toBeNull()
    expect(apiErrorCode(http({ code: 5 }, 409))).toBeNull()
    expect(apiErrorCode(http(['code'], 409))).toBeNull()
    expect(apiErrorCode(new Error('x'))).toBeNull()
    expect(apiErrorCode(new ApiError(0, null, 'network'))).toBeNull()
  })

  it('recognises a missing endpoint', () => {
    expect(isEndpointMissing(http(null, 404))).toBe(true)
    expect(isEndpointMissing(http(null, 405))).toBe(true)
    expect(isEndpointMissing(http(null, 501))).toBe(true)
    expect(isEndpointMissing(http(null, 500))).toBe(false)
    expect(isEndpointMissing(new ApiError(0, null, 'network'))).toBe(false)
  })
})

describe('404 classification', () => {
  it('treats a DRF JSON 404 as an answer from the API, not a missing route', () => {
    expect(isEndpointMissing(http({ detail: 'Not found.', code: 'not_found' }, 404))).toBe(false)
    expect(isEndpointMissing(http({ detail: 'Invalid page.' }, 404))).toBe(false)
  })

  it('treats a bodyless or HTML 404 as a missing route', () => {
    expect(isEndpointMissing(http(null, 404))).toBe(true)
    expect(isEndpointMissing(http({}, 404))).toBe(true)
    expect(isEndpointMissing(http('<html>', 404))).toBe(true)
  })

  it('recognises an out-of-range page', () => {
    expect(isPageOutOfRange(http({ detail: 'Invalid page.' }, 404))).toBe(true)
    expect(isPageOutOfRange(http({ detail: 'x', code: 'invalid_page' }, 404))).toBe(true)
    expect(isPageOutOfRange(http({ detail: 'Not found.' }, 404))).toBe(false)
    expect(isPageOutOfRange(http({ detail: 'Invalid page.' }, 400))).toBe(false)
    expect(isPageOutOfRange(http(null, 404))).toBe(false)
  })

  it('cleans and bounds the server text shown for a 400', () => {
    const text = describeError(http({ detail: `bad‮${'x'.repeat(1000)}` }), 'fallback')
    expect(text).not.toContain('‮')
    expect(text.length).toBeLessThanOrEqual(301)
  })
})
