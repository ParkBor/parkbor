import { describe, expect, it, vi } from 'vitest'
import { buildReverseUrl, parseAddress, reverseGeocode } from './reverseGeocode'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('buildReverseUrl', () => {
  it('asks Nominatim for jsonv2 at zoom 18 in the UI language', () => {
    const url = new URL(buildReverseUrl(41.2755, 69.2034, 'ru'))
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/reverse')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: 'jsonv2',
      lat: '41.2755',
      lon: '69.2034',
      zoom: '18',
      'accept-language': 'ru',
    })
  })
})

describe('parseAddress', () => {
  it('builds "road number, locality" from the address parts', () => {
    expect(
      parseAddress({
        display_name: 'long, display, name, Tashkent, Uzbekistan',
        address: { road: 'Amir Temur ko‘chasi', house_number: '12', suburb: 'Yunusobod', city: 'Toshkent' },
      }),
    ).toBe('Amir Temur ko‘chasi 12, Yunusobod')
  })

  it('uses the city when there is no suburb, and a road alone is enough', () => {
    expect(parseAddress({ address: { road: 'Navoiy', city: 'Toshkent' } })).toBe('Navoiy, Toshkent')
    expect(parseAddress({ address: { road: 'Navoiy' } })).toBe('Navoiy')
  })

  it('falls back to the first three parts of display_name', () => {
    expect(parseAddress({ display_name: 'A, B, C, D, E' })).toBe('A, B, C')
  })

  it('cleans control and bidi characters and bounds the length', () => {
    expect(parseAddress({ address: { road: `Ma${String.fromCodePoint(0x202e)}in`, house_number: '1' } })).toBe('Main 1')
    expect((parseAddress({ display_name: 'x'.repeat(900) }) ?? '').length).toBeLessThanOrEqual(301)
  })

  it.each([null, undefined, 'text', 42, [], {}, { display_name: 5 }, { address: 'x' }, { display_name: '' }])(
    'returns null for the malformed body %j',
    (body) => {
      expect(parseAddress(body)).toBeNull()
    },
  )

  it('ignores non-string address parts', () => {
    expect(parseAddress({ address: { road: { a: 1 }, city: 7 }, display_name: 'Z, Y' })).toBe('Z, Y')
  })
})

describe('reverseGeocode', () => {
  it('returns the parsed address', async () => {
    const fetchImpl = vi.fn(async () => json({ address: { road: 'Navoiy', house_number: '3' } }))
    expect(await reverseGeocode(41.3, 69.2, { language: 'uz', fetchImpl })).toBe('Navoiy 3')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('accept-language=uz')
    expect(init.credentials).toBe('omit')
  })

  it('returns null silently for http errors, bad JSON, network errors and bad coordinates', async () => {
    expect(await reverseGeocode(1, 1, { language: 'uz', fetchImpl: async () => json({}, 429) })).toBeNull()
    expect(
      await reverseGeocode(1, 1, { language: 'uz', fetchImpl: async () => new Response('<html>', { status: 200 }) }),
    ).toBeNull()
    expect(
      await reverseGeocode(1, 1, {
        language: 'uz',
        fetchImpl: async () => {
          throw new TypeError('offline')
        },
      }),
    ).toBeNull()
    const never = vi.fn()
    expect(await reverseGeocode(91, 0, { language: 'uz', fetchImpl: never })).toBeNull()
    expect(await reverseGeocode(Number.NaN, 0, { language: 'uz', fetchImpl: never })).toBeNull()
    expect(never).not.toHaveBeenCalled()
  })

  it('aborts when the caller cancels (a newer pick replaced it)', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    ) as unknown as typeof fetch
    const pending = reverseGeocode(1, 1, { language: 'en', fetchImpl, signal: controller.signal })
    controller.abort()
    expect(await pending).toBeNull()
  })

  it('gives up after the timeout', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')))
      })) as unknown as typeof fetch
    expect(await reverseGeocode(1, 1, { language: 'en', fetchImpl, timeoutMs: 20 })).toBeNull()
  })

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return json({ display_name: 'A, B' })
    }) as unknown as typeof fetch
    expect(await reverseGeocode(1, 1, { language: 'en', fetchImpl, signal: controller.signal })).toBeNull()
  })
})
