import { describe, expect, it } from 'vitest'
import { detectLanguage } from './detect'

describe('detectLanguage', () => {
  it('prefers a stored valid choice', () => {
    expect(detectLanguage('ru', ['en-US'])).toBe('ru')
  })

  it('ignores a stored unsupported value', () => {
    expect(detectLanguage('de', ['en-US'])).toBe('en')
    expect(detectLanguage('<script>', [])).toBe('uz')
  })

  it('uses the first supported browser language', () => {
    expect(detectLanguage(null, ['de-DE', 'ru-RU', 'en'])).toBe('ru')
    expect(detectLanguage(null, ['UZ-latn'])).toBe('uz')
  })

  it('falls back to uz', () => {
    expect(detectLanguage(null, ['fr'])).toBe('uz')
    expect(detectLanguage(null, [])).toBe('uz')
  })
})
