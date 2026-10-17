import { describe, expect, it } from 'vitest'
import { en, ru, uz } from './locales'

function keys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? keys(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  )
}

describe('locales', () => {
  it('ru and en define exactly the same keys as uz', () => {
    expect(keys(ru)).toEqual(keys(uz))
    expect(keys(en)).toEqual(keys(uz))
  })

  it('has no empty strings', () => {
    for (const locale of [uz, ru, en]) {
      const empty = keys(locale).filter((k) =>
        k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], locale) === '',
      )
      expect(empty).toEqual([])
    }
  })
})
