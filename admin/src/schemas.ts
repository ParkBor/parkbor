import { z } from 'zod'

// Error messages are i18n keys; components translate them with t().
export const MAX_BULK_SLOTS = 500
export const MAX_SLOT_NUMBER = 99999
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const PRICE_RE = /^\d{1,10}(\.\d{1,2})?$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const PREFIX_RE = /^[A-Za-z0-9]{1,10}$/

const optionalTime = z
  .string()
  .refine((value) => value === '' || TIME_RE.test(value), { message: 'validation.timeFormat' })

export const parkingSchema = z
  .object({
    name: z.string().trim().min(1, 'validation.required').max(200, 'validation.nameTooLong'),
    address: z.string().trim().min(1, 'validation.required').max(300, 'validation.nameTooLong'),
    lat: z
      .number({ error: 'validation.required' })
      .min(-90, 'validation.latRange')
      .max(90, 'validation.latRange'),
    lng: z
      .number({ error: 'validation.required' })
      .min(-180, 'validation.lngRange')
      .max(180, 'validation.lngRange'),
    open_time: optionalTime,
    close_time: optionalTime,
    // Only ADMIN assigns an owner (UUID); for OWNER the backend always uses the caller.
    owner: z
      .string()
      .refine((value) => value === '' || UUID_RE.test(value), { message: 'validation.uuid' })
      .optional(),
  })
  .refine((v) => (v.open_time === '') === (v.close_time === ''), {
    message: 'validation.timesTogether',
    path: ['close_time'],
  })

export type ParkingFormValues = z.infer<typeof parkingSchema>

export const bulkSlotsSchema = z
  .object({
    zone: z.string().min(1, 'validation.required'),
    prefix: z.string().regex(PREFIX_RE, 'validation.prefixFormat'),
    start: z
      .number({ error: 'validation.required' })
      .int('validation.integer')
      .min(1, 'validation.startMin')
      .max(MAX_SLOT_NUMBER, 'validation.tooManySlots'),
    end: z
      .number({ error: 'validation.required' })
      .int('validation.integer')
      .min(1, 'validation.startMin')
      .max(MAX_SLOT_NUMBER, 'validation.tooManySlots'),
    type: z.enum(['STANDARD', 'EV', 'DISABLED', 'LARGE']),
    distance_to_entrance: z
      .number({ error: 'validation.required' })
      .int('validation.integer')
      .min(0, 'validation.nonNegative'),
  })
  .refine((v) => v.end >= v.start, { message: 'validation.endBeforeStart', path: ['end'] })
  .refine((v) => v.end - v.start + 1 <= MAX_BULK_SLOTS, {
    message: 'validation.tooManySlots',
    path: ['end'],
  })

export type BulkSlotsFormValues = z.infer<typeof bulkSlotsSchema>

export const tariffSchema = z.object({
  slot_type: z.enum(['STANDARD', 'EV', 'DISABLED', 'LARGE']),
  // Kept as a string end to end: money is never converted to a float.
  price_per_hour: z.string().regex(PRICE_RE, 'validation.priceFormat'),
})

export type TariffFormValues = z.infer<typeof tariffSchema>

export const zoneSchema = z.object({
  name: z.string().trim().min(1, 'validation.required').max(100, 'validation.nameTooLong'),
  floor: z.number({ error: 'validation.required' }).int('validation.integer'),
})

export type ZoneFormValues = z.infer<typeof zoneSchema>
