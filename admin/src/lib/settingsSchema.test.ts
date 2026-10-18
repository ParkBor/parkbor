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
