import { ApiError } from '@habi/api-client'
import { describe, expect, it } from 'vitest'
import { errorText } from './errorText'

const t = ((key: string) => key) as never

describe('errorText', () => {
  it('names a missing endpoint', () => {
    expect(errorText(new ApiError(404, null, 'http'), t)).toBe('common.endpointUnavailable')
    expect(errorText(new ApiError(405, null, 'http'), t)).toBe('common.endpointUnavailable')
  })
  it('shows only 400 validation text, otherwise the generic line', () => {
    expect(errorText(new ApiError(400, { detail: 'Bad value' }, 'http'), t)).toBe('Bad value')
    expect(errorText(new ApiError(500, { detail: 'secret' }, 'http'), t)).toBe('common.error')
    expect(errorText(new ApiError(404, { detail: 'Not found.' }, 'http'), t)).toBe('common.error')
  })
})
