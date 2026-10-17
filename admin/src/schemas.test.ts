import { describe, expect, it } from 'vitest'
import { bulkSlotsSchema, parkingSchema, tariffSchema, zoneSchema } from './schemas'

const validParking = {
  name: 'Chilonzor P1',
  address: 'Chilonzor 7',
  lat: 41.27,
  lng: 69.2,
  open_time: '',
  close_time: '',
}

function firstMessage(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues[0]?.message
}

describe('parkingSchema', () => {
  it('accepts a valid lot', () => {
    expect(parkingSchema.safeParse(validParking).success).toBe(true)
  })

  it.each([
    [{ name: '' }, 'validation.required'],
    [{ name: '   ' }, 'validation.required'],
    [{ name: 'x'.repeat(201) }, 'validation.nameTooLong'],
    [{ lat: 91 }, 'validation.latRange'],
    [{ lat: -90.1 }, 'validation.latRange'],
    [{ lng: 181 }, 'validation.lngRange'],
    [{ lat: undefined }, 'validation.required'],
    [{ open_time: '8:00', close_time: '22:00' }, 'validation.timeFormat'],
    [{ open_time: '25:00', close_time: '22:00' }, 'validation.timeFormat'],
    [{ open_time: '08:00' }, 'validation.timesTogether'],
  ])('rejects %j with %s', (patch, key) => {
    const result = parkingSchema.safeParse({ ...validParking, ...patch })
    expect(result.success).toBe(false)
    expect(firstMessage(result)).toBe(key)
  })

  it('accepts boundary coordinates and overnight hours', () => {
    const result = parkingSchema.safeParse({
      ...validParking,
      lat: 90,
      lng: -180,
      open_time: '22:00',
      close_time: '06:00',
    })
    expect(result.success).toBe(true)
  })
})

describe('bulkSlotsSchema', () => {
  const valid = {
    zone: 'zone-id',
    prefix: 'A',
    start: 1,
    end: 50,
    type: 'STANDARD',
    distance_to_entrance: 0,
  }

  it('accepts zone A, 1-50', () => {
    expect(bulkSlotsSchema.safeParse(valid).success).toBe(true)
  })

  it.each([
    [{ prefix: '' }, 'validation.prefixFormat'],
    [{ prefix: 'A-1' }, 'validation.prefixFormat'],
    [{ zone: '' }, 'validation.required'],
    [{ start: 0 }, 'validation.startMin'],
    [{ start: 1.5 }, 'validation.integer'],
    [{ start: 10, end: 5 }, 'validation.endBeforeStart'],
    [{ end: 501 }, 'validation.tooManySlots'],
    [{ distance_to_entrance: -1 }, 'validation.nonNegative'],
    [{ type: 'BOAT' }, undefined],
  ])('rejects %j', (patch, key) => {
    const result = bulkSlotsSchema.safeParse({ ...valid, ...patch })
    expect(result.success).toBe(false)
    if (key) expect(firstMessage(result)).toBe(key)
  })

  it('allows exactly 500 slots', () => {
    expect(bulkSlotsSchema.safeParse({ ...valid, start: 1, end: 500 }).success).toBe(true)
  })
})

describe('tariffSchema (money stays a string)', () => {
  it.each(['0', '12000', '12000.5', '12000.50'])('accepts %s', (price) => {
    expect(tariffSchema.safeParse({ slot_type: 'EV', price_per_hour: price }).success).toBe(true)
  })

  it.each(['', '-1', '1.005', 'abc', '1,5', '1e3', '12345678901'])('rejects %j', (price) => {
    const result = tariffSchema.safeParse({ slot_type: 'EV', price_per_hour: price })
    expect(result.success).toBe(false)
    expect(firstMessage(result)).toBe('validation.priceFormat')
  })
})

describe('zoneSchema', () => {
  it('requires a name and integer floor', () => {
    expect(zoneSchema.safeParse({ name: 'A', floor: -1 }).success).toBe(true)
    expect(zoneSchema.safeParse({ name: '', floor: 0 }).success).toBe(false)
    expect(zoneSchema.safeParse({ name: 'A', floor: 1.5 }).success).toBe(false)
  })
})
