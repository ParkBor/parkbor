import type { AdminSettings } from '@habi/api-client'
import { z } from 'zod'

// Ranges mirror backend bookings.conf.EDITABLE_SETTINGS (the server stays the authority).
const MAX_PERCENT = 100

const minutes = (min: number, max: number) =>
  z
    .number({ error: 'validation.integer' })
    .int('validation.integer')
    .min(min, 'validation.range')
    .max(max, 'validation.range')
const percent = z
  .number({ error: 'validation.integer' })
  .int('validation.integer')
  .min(0, 'validation.percentRange')
  .max(MAX_PERCENT, 'validation.percentRange')

/** Error messages are i18n keys (resolved by the form). The server re-validates everything. */
export const settingsSchema = z.object({
  hold_minutes: minutes(5, 120),
  no_show_grace_minutes: minutes(5, 240),
  cancel_full_refund_minutes: minutes(0, 10080),
  cancel_full_percent: percent,
  cancel_late_percent: percent,
  cancel_after_start_percent: percent,
})

export type SettingsValues = z.infer<typeof settingsSchema>

export const SETTINGS_FIELDS = [
  'hold_minutes',
  'no_show_grace_minutes',
  'cancel_full_refund_minutes',
  'cancel_full_percent',
  'cancel_late_percent',
  'cancel_after_start_percent',
] as const satisfies readonly (keyof AdminSettings)[]

type FieldErrors = Partial<Record<keyof AdminSettings, string>>

/** Cross-field rule (server too): cancel_after_start_percent <= cancel_late_percent <= cancel_full_percent. */
function orderErrors(values: SettingsValues, found: FieldErrors): FieldErrors {
  const errors: FieldErrors = {}
  if (!found.cancel_late_percent && !found.cancel_full_percent && values.cancel_late_percent > values.cancel_full_percent) {
    errors.cancel_late_percent = 'validation.percentOrder'
  }
  if (!found.cancel_after_start_percent && !found.cancel_late_percent && values.cancel_after_start_percent > values.cancel_late_percent) {
    errors.cancel_after_start_percent = 'validation.percentOrder'
  }
  return errors
}

/** First error key per field, or an empty object when the values are valid. */
export function settingsErrors(values: unknown): FieldErrors {
  const result = settingsSchema.safeParse(values)
  const errors: FieldErrors = {}
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path[0] as keyof AdminSettings | undefined
      if (field && !(field in errors)) errors[field] = issue.message
    }
  }
  const candidate = values as Partial<SettingsValues> | null
  const numeric = (key: keyof SettingsValues) => typeof candidate?.[key] === 'number'
  if (numeric('cancel_full_percent') && numeric('cancel_late_percent') && numeric('cancel_after_start_percent')) {
    return { ...orderErrors(candidate as SettingsValues, errors), ...errors }
  }
  return errors
}
