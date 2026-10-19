import type { TFunction } from 'i18next'
import { safeText } from './format'

const ACTORS = ['driver', 'operator', 'owner', 'admin', 'system']

/** BookingEvent.actor is a role label (never an id); null means the system. */
export function actorLabel(actor: unknown, t: TFunction): string {
  if (actor === null || actor === undefined || actor === '') return t('bookings.actors.system')
  const text = safeText(actor, 20).toLowerCase()
  return ACTORS.includes(text) ? t(`bookings.actors.${text}`) : safeText(actor, 20)
}
