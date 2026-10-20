import { describe, expect, it } from 'vitest'
import { toPayload } from './payload'

const base = { name: 'A', address: 'B', lat: 41.3, lng: 69.2, open_time: '', close_time: '' }

describe('toPayload', () => {
  it('sends the owner as a number under owner_telegram_id', () => {
    expect(toPayload({ ...base, owner_telegram_id: '123456789' })).toMatchObject({
      owner_telegram_id: 123456789,
    })
  })

  it('omits the owner when empty or absent, and never sends the old uuid key', () => {
    expect('owner_telegram_id' in toPayload({ ...base, owner_telegram_id: '' })).toBe(false)
    expect('owner_telegram_id' in toPayload(base)).toBe(false)
    expect('owner' in toPayload({ ...base, owner_telegram_id: '5' })).toBe(false)
  })

  it('maps location and empty times', () => {
    expect(toPayload(base)).toMatchObject({
      location: { lat: 41.3, lng: 69.2 },
      open_time: null,
      close_time: null,
    })
  })
})
