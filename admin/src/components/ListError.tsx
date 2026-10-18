import { Alert } from 'antd'
import { useTranslation } from 'react-i18next'
import { isEndpointMissing } from '../lib/errors'
import { QueryError } from './QueryError'

interface ListErrorProps {
  error: unknown
  onRetry?: () => void
}

/**
 * Error state for list / stats queries. A 404/405/501 from a collection URL means the backend
 * does not serve that resource yet; say so instead of a generic failure or an empty table.
 */
export function ListError({ error, onRetry }: ListErrorProps) {
  const { t } = useTranslation()
  if (isEndpointMissing(error)) {
    return <Alert type="warning" showIcon message={t('common.endpointUnavailable')} />
  }
  return <QueryError error={error} onRetry={onRetry} />
}
