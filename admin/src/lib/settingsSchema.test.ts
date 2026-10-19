import { describe, expect, it } from 'vitest'
import { settingsErrors } from './settingsSchema'

const valid = {
  hold_minutes: 10,
  no_show_grace_minutes: 20,
  cancel_full_refund_minutes: 60,
  cancel_full_percent: 100,
  cancel_late_percent: 50,
  cancel_after_start_percent: 0,
}

describe('settingsErrors', () => {
  it('accepts valid values and the boundaries', () => {
    expect(settingsErrors(valid)).toEqual({})
    expect(settingsErrors({ ...valid, cancel_late_percent: 0, cancel_full_percent: 100 })).toEqual({})
    expect(settingsErrors({ ...valid, cancel_full_refund_minutes: 0 })).toEqual({})
  })

  it('rejects percentages outside 0..100', () => {
    expect(settingsErrors({ ...valid, cancel_late_percent: 101 })).toEqual({
      cancel_late_percent: 'validation.percentRange',
    })
    expect(settingsErrors({ ...valid, cancel_late_percent: -1 })).toEqual({
      cancel_late_percent: 'validation.percentRange',
    })
  })

  it('uses the server ranges: hold 5..120, grace 5..240, refund window 0..10080', () => {
    expect(settingsErrors({ ...valid, hold_minutes: 5 })).toEqual({})
    expect(settingsErrors({ ...valid, hold_minutes: 4 }).hold_minutes).toBe('validation.range')
    expect(settingsErrors({ ...valid, no_show_grace_minutes: 5 })).toEqual({})
    expect(settingsErrors({ ...valid, no_show_grace_minutes: 4 }).no_show_grace_minutes).toBe('validation.range')
    expect(settingsErrors({ ...valid, hold_minutes: 120 })).toEqual({})
    expect(settingsErrors({ ...valid, hold_minutes: 121 }).hold_minutes).toBe('validation.range')
    expect(settingsErrors({ ...valid, no_show_grace_minutes: 240 })).toEqual({})
    expect(settingsErrors({ ...valid, no_show_grace_minutes: 241 }).no_show_grace_minutes).toBe('validation.range')
    expect(settingsErrors({ ...valid, cancel_full_refund_minutes: 10080 })).toEqual({})
    expect(settingsErrors({ ...valid, cancel_full_refund_minutes: 10081 }).cancel_full_refund_minutes).toBe('validation.range')
  })

  it('enforces after_start <= late <= full', () => {
    expect(settingsErrors({ ...valid, cancel_full_percent: 50, cancel_late_percent: 50, cancel_after_start_percent: 50 })).toEqual({})
    expect(settingsErrors({ ...valid, cancel_full_percent: 40, cancel_late_percent: 50 })).toEqual({
      cancel_late_percent: 'validation.percentOrder',
    })
    expect(settingsErrors({ ...valid, cancel_late_percent: 20, cancel_after_start_percent: 30 })).toEqual({
      cancel_after_start_percent: 'validation.percentOrder',
    })
  })

  it('rejects zero hold time and fractions', () => {
    expect(settingsErrors({ ...valid, hold_minutes: 0 }).hold_minutes).toBe('validation.range')
    expect(settingsErrors({ ...valid, hold_minutes: 1.5 }).hold_minutes).toBe('validation.integer')
  })

  it('rejects missing, null and string values', () => {
    expect(Object.keys(settingsErrors({}))).toHaveLength(6)
    expect(settingsErrors({ ...valid, hold_minutes: null }).hold_minutes).toBe('validation.integer')
    expect(settingsErrors({ ...valid, hold_minutes: '10' }).hold_minutes).toBe('validation.integer')
  })

  it('rejects absurdly large minutes', () => {
    expect(settingsErrors({ ...valid, no_show_grace_minutes: 10 ** 7 }).no_show_grace_minutes).toBe(
      'validation.range',
    )
  })
})
