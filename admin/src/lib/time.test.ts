import { describe, expect, it } from 'vitest'
import { addDays, tashkentNextDayStart, tashkentDayStart, tashkentToday, toRangeParams } from './time'

describe('Tashkent day bounds', () => {
  it('builds offset-aware ISO strings (to is the EXCLUSIVE next-day start) (Tashkent is UTC+5 all year)', () => {
    expect(tashkentDayStart('2026-10-17')).toBe('2026-10-17T00:00:00+05:00')
    expect(tashkentNextDayStart('2026-10-17')).toBe('2026-10-18T00:00:00+05:00')
  })

  it.each(['', '17.10.2026', '2026-13-01', '2026-02-30', "2026-10-17'; DROP"])(
    'rejects the malformed date %j',
    (value) => {
      expect(tashkentDayStart(value)).toBeUndefined()
      expect(tashkentNextDayStart(value)).toBeUndefined()
    },
  )

  it('maps a picked range to from/to parameters', () => {
    expect(toRangeParams(['2026-10-01', '2026-10-07'])).toEqual({
      from: '2026-10-01T00:00:00+05:00',
      to: '2026-10-08T00:00:00+05:00',
    })
    expect(toRangeParams(null)).toEqual({})
    expect(toRangeParams(['', '2026-10-07'])).toEqual({ to: '2026-10-08T00:00:00+05:00' })
  })
})

describe('calendar helpers', () => {
  it('finds the Tashkent day even when UTC is still on the previous day', () => {
    expect(tashkentToday(new Date('2026-10-16T20:30:00Z'))).toBe('2026-10-17')
    expect(tashkentToday(new Date('2026-10-17T18:59:00Z'))).toBe('2026-10-17')
    expect(tashkentToday(new Date('2026-10-17T19:00:00Z'))).toBe('2026-10-18')
  })

  it('adds and subtracts days across month and year ends', () => {
    expect(addDays('2026-10-17', -6)).toBe('2026-10-11')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})
