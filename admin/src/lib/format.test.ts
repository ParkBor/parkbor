import { describe, expect, it } from 'vitest'
import {
  barPercent,
  formatDateTime,
  formatMoney,
  formatPercent,
  isUuid,
  metaText,
  safeMultiline,
  shortId,
  percentValue,
  moneyToMinor,
  safeText,
} from './format'

describe('formatMoney', () => {
  it('groups thousands without touching the digits (no float maths)', () => {
    expect(formatMoney('12000.00')).toBe('12 000')
    expect(formatMoney('1234567.50')).toBe('1 234 567.50')
    expect(formatMoney('0')).toBe('0')
    expect(formatMoney('999')).toBe('999')
  })

  it('keeps digits a float could not hold', () => {
    expect(formatMoney('9007199254740993.01')).toBe('9 007 199 254 740 993.01')
  })

  it.each(['abc', '', '1e5', '12,5', '1.234', '--1', null, undefined, '<b>1</b>'])(
    'shows a dash for the invalid amount %j',
    (value) => {
      expect(formatMoney(value as string)).toBe('—')
    },
  )

  it('handles negative amounts', () => {
    expect(formatMoney('-1500.00')).toBe('-1 500')
  })
})

describe('moneyToMinor / barPercent', () => {
  it('converts to integer minor units', () => {
    expect(moneyToMinor('12.5')).toBe(1250n)
    expect(moneyToMinor('12')).toBe(1200n)
    expect(moneyToMinor('0.05')).toBe(5n)
    expect(moneyToMinor('x')).toBeNull()
  })

  it('computes a bar width with integer maths', () => {
    expect(barPercent('50.00', '200.00')).toBe(25)
    expect(barPercent('200', '200')).toBe(100)
    expect(barPercent('0', '0')).toBe(0)
    expect(barPercent('bad', '10')).toBe(0)
    expect(barPercent('300', '200')).toBe(100)
  })
})

describe('formatPercent', () => {
  it('appends a percent sign to a valid decimal', () => {
    expect(formatPercent('62.50')).toBe('62.50%')
    expect(formatPercent('100')).toBe('100%')
  })
  it('rejects junk', () => {
    expect(formatPercent('abc')).toBe('—')
    expect(formatPercent(undefined)).toBe('—')
  })
})

describe('safeText', () => {
  it('removes control, bidi and zero-width characters', () => {
    expect(safeText('a‮b​c\u0007d\u0000e')).toBe('abcde')
  })
  it('truncates long text', () => {
    const out = safeText('x'.repeat(600), 10)
    expect(out).toBe(`${'x'.repeat(10)}…`)
  })
  it('turns null and non-strings into text and keeps markup inert as plain text', () => {
    expect(safeText(null)).toBe('')
    expect(safeText(42)).toBe('42')
    expect(safeText('<script>alert(1)</script>')).toBe('<script>alert(1)</script>')
  })
  it('keeps ordinary Unicode (Cyrillic, Uzbek, emoji)', () => {
    expect(safeText('Привет oʻzbek 🚗')).toBe('Привет oʻzbek 🚗')
  })
})

describe('formatDateTime', () => {
  it('shows Asia/Tashkent time (UTC+5) whatever the browser zone is', () => {
    expect(formatDateTime('2026-10-17T19:30:00Z', 'en')).toMatch(/00:30/)
    expect(formatDateTime('2026-10-17T19:30:00Z', 'en')).toMatch(/18/)
  })
  it('shows a dash for empty or invalid input', () => {
    expect(formatDateTime(null, 'uz')).toBe('—')
    expect(formatDateTime('nope', 'uz')).toBe('—')
  })
})

describe('isUuid', () => {
  it('accepts UUIDs only', () => {
    expect(isUuid('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    expect(isUuid('../x')).toBe(false)
    expect(isUuid('')).toBe(false)
  })
})

describe('percentValue / metaText', () => {
  it('clamps and rejects', () => {
    expect(percentValue('62.5')).toBe(62.5)
    expect(percentValue('250')).toBe(100)
    expect(percentValue('x')).toBe(0)
    expect(percentValue(undefined)).toBe(0)
  })
  it('prints meta as bounded safe text', () => {
    expect(metaText({ a: '<b>' })).toContain('<b>')
    expect(metaText(undefined)).toBe('')
    expect(metaText('x'.repeat(5000)).length).toBeLessThan(2100)
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    expect(metaText(cyc)).toBe('')
  })
})

describe('safeText line breaks', () => {
  const nl = String.fromCharCode(10)
  const tab = String.fromCharCode(9)
  const cr = String.fromCharCode(13)
  const bel = String.fromCharCode(7)
  it('turns tabs and line breaks into one space instead of gluing words', () => {
    expect(safeText('a' + nl + 'b' + tab + tab + 'c' + cr + nl + 'd')).toBe('a b c d')
  })
  it('safeMultiline keeps line breaks and drops other controls', () => {
    expect(safeMultiline('a' + nl + 'b' + bel + 'c' + cr + nl + 'd')).toBe('a' + nl + 'bc' + nl + 'd')
    expect(safeMultiline(null)).toBe('')
  })
})

describe('shortId', () => {
  it('shortens ids and survives odd values', () => {
    expect(shortId('123e4567-e89b-12d3-a456-426614174000')).toBe('123e4567')
    expect(shortId(undefined)).toBe('')
    expect(shortId(null)).toBe('')
    expect(shortId(12345678901)).toBe('12345678')
  })
})
