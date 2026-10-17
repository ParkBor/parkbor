import { ApiError } from '@habi/api-client'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useServerErrors } from './formErrors'

const err = (body: unknown) => new ApiError(400, body, 'http')

describe('useServerErrors', () => {
  it('maps own fields and reports the rest as a general message', () => {
    const setError = vi.fn()
    const { result } = renderHook(() =>
      useServerErrors<{ lat: string }>(err({ location: ['bad'], other: ['x'] }), setError, { location: 'lat' }),
    )
    expect(setError).toHaveBeenCalledWith('lat', { type: 'server', message: 'bad' })
    expect(result.current).toBe('other: x')
  })

  it('does not treat inherited Object.prototype keys as mapped fields', () => {
    const setError = vi.fn()
    const body = JSON.parse('{"constructor": ["c"], "__proto__": ["p"], "toString": ["t"]}') as unknown
    const { result } = renderHook(() => useServerErrors<{ lat: string }>(err(body), setError, {}))
    expect(setError).not.toHaveBeenCalled()
    expect(result.current).toContain('constructor: c')
    expect(result.current).toContain('__proto__: p')
    expect(result.current).toContain('toString: t')
  })
})
