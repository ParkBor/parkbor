import type { TFunction } from 'i18next'
import { describeError, isEndpointMissing } from './errors'

/** One user-facing line for any failed request: a missing endpoint is named as such. */
export function errorText(error: unknown, t: TFunction): string {
  return isEndpointMissing(error) ? t('common.endpointUnavailable') : describeError(error, t('common.error'))
}
