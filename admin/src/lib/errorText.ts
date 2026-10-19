import type { TFunction } from 'i18next'
import { apiErrorCode, describeError, isEndpointMissing } from './errors'

/** One user-facing line for any failed request: a missing endpoint is named as such. */
export function errorText(error: unknown, t: TFunction): string {
  return isEndpointMissing(error) ? t('common.endpointUnavailable') : describeError(error, t('common.error'))
}

const USER_ERROR_CODES = [
  'cannot_modify_self',
  'super_admin_protected',
  'super_admin_required',
  'last_admin',
  'owner_has_parkings',
]

/** Error line for PATCH /admin/users/{id}: the server's refusal codes get their own text. */
export function userErrorText(error: unknown, t: TFunction): string {
  const code = apiErrorCode(error)
  return code !== null && USER_ERROR_CODES.includes(code) ? t(`users.errors.${code}`) : errorText(error, t)
}
