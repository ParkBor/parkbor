import { ApiError } from '@habi/api-client'
import { describe, expect, it } from 'vitest'
import { en, ru, uz } from '../i18n/locales'
import { SessionSupersededError } from './auth'
import { AUTH_ERROR_KEYS, loginErrorKey, safeRedirectTarget } from './authErrors'

const http = (status: number, body: unknown = null) => new ApiError(status, body, 'http')

function lookup(locale: object, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale)
}

describe('loginErrorKey', () => {
  it.each([
    [http(400, { code: 'invalid_widget' }), 'auth.errors.invalidWidget'],
    [http(400, { hash: ['bad'] }), 'auth.errors.invalidWidget'],
    [http(403, { code: 'role_not_allowed' }), 'auth.errors.noRole'],
    [http(403, { code: 'account_disabled' }), 'auth.errors.accountDisabled'],
    [http(403), 'auth.errors.noRole'],
    [http(429), 'auth.errors.tooMany'],
    [http(500), 'auth.errors.unknown'],
    [http(401), 'auth.errors.unknown'],
    [new ApiError(0, 'x', 'network'), 'auth.errors.network'],
    [new ApiError(0, 'x', 'timeout'), 'auth.errors.network'],
    [new ApiError(200, null, 'parse'), 'auth.errors.unknown'],
    [new Error('boom'), 'auth.errors.unknown'],
    ['weird', 'auth.errors.unknown'],
  ])('maps %j', (error, key) => expect(loginErrorKey(error)).toBe(key))

  it.each([new ApiError(0, null, 'abort'), new SessionSupersededError()])(
    'returns null for %s (nothing to show)',
    (error) => expect(loginErrorKey(error)).toBeNull(),
  )

  it.each(AUTH_ERROR_KEYS)('%s exists and is non-empty in uz, ru and en', (key) => {
    for (const locale of [uz, ru, en]) {
      const text = lookup(locale, key)
      expect(typeof text).toBe('string')
      expect((text as string).length).toBeGreaterThan(0)
    }
  })

  it('only ever returns declared keys', () => {
    const produced = [
      loginErrorKey(http(400)),
      loginErrorKey(http(403)),
      loginErrorKey(http(429)),
      loginErrorKey(new ApiError(0, null, 'network')),
      loginErrorKey('x'),
    ]
    for (const key of produced) expect(AUTH_ERROR_KEYS).toContain(key)
  })
})

describe('safeRedirectTarget', () => {
  it.each([
    [{ pathname: '/tariffs', search: '?a=1', hash: '' }, '/tariffs?a=1'],
    [{ pathname: '/parkings', search: '', hash: '#x' }, '/parkings#x'],
    [{ pathname: '/parkings/abc/edit' }, '/parkings/abc/edit'],
  ])('keeps the in-app target %j', (from, expected) => expect(safeRedirectTarget(from)).toBe(expected))

  it.each([
    undefined,
    null,
    'string',
    {},
    { pathname: '//evil.example' },
    { pathname: 'https://evil.example' },
    { pathname: '/login' },
    { pathname: '/LOGIN' },
    { pathname: '/./login' },
    { pathname: '/a/../login' },
    { pathname: '/a/..//evil.com' },
    { pathname: '/.//evil.com' },
    { pathname: '/..//evil.com' },
    { pathname: '/Login/x' },
    { pathname: '/%6Cogin' },
    { pathname: '/\\evil' },
    { pathname: '/a\tb' },
    { pathname: '/a\nb' },
    { pathname: '/a\rb' },
    { pathname: '/a\u0000b' },
    { pathname: '/ok', search: 'x=1' },
    { pathname: '/ok', search: '//evil' },
    { pathname: '/ok', hash: 'frag' },
    { pathname: '/ok', search: '?a\nb' },
    { pathname: 42 },
  ])('falls back to /dashboard for %j', (from) => expect(safeRedirectTarget(from)).toBe('/dashboard'))
})
