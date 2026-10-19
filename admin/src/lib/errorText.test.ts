import { ApiError } from '@habi/api-client'
import { describe, expect, it } from 'vitest'
import { errorText, userErrorText } from './errorText'

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

describe('userErrorText', () => {
  it.each([
    [403, 'cannot_modify_self'],
    [403, 'super_admin_protected'],
    [403, 'super_admin_required'],
    [409, 'last_admin'],
    [409, 'owner_has_parkings'],
  ])('maps %i %s to its own message', (status, code) => {
    expect(userErrorText(new ApiError(status, { detail: 'English text', code }, 'http'), t)).toBe(`users.errors.${code}`)
  })

  it('falls back to the generic line for anything else', () => {
    expect(userErrorText(new ApiError(403, { detail: 'x', code: 'permission_denied' }, 'http'), t)).toBe('common.error')
    expect(userErrorText(new ApiError(404, null, 'http'), t)).toBe('common.endpointUnavailable')
  })
})
