import type { AdminSettings } from '@habi/api-client'
import { z } from 'zod'

const MAX_MINUTES = 7 * 24 * 60
const MAX_PERCENT = 100

const minutes = (min: number) =>
  z.number({ error: 'validation.integer' }).int('validation.integer').min(min, 'validation.range').max(MAX_MINUTES, 'validation.range')
const percent = z
  .number({ error: 'validation.integer' })
  .int('validation.integer')
  .min(0, 'validation.percentRange')
  .max(MAX_PERCENT, 'validation.percentRange')

/** Error messages are i18n keys (resolved by the form). The server re-validates everything. */
export const settingsSchema = z.object({
  hold_minutes: minutes(1),
  no_show_grace_minutes: minutes(1),
  cancel_full_refund_minutes: minutes(0),
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

/** First error key per field, or an empty object when the values are valid. */
export function settingsErrors(values: unknown): Partial<Record<keyof AdminSettings, string>> {
  const result = settingsSchema.safeParse(values)
  if (result.success) return {}
  const errors: Partial<Record<keyof AdminSettings, string>> = {}
  for (const issue of result.error.issues) {
    const field = issue.path[0] as keyof AdminSettings | undefined
    if (field && !(field in errors)) errors[field] = issue.message
  }
  return errors
}
