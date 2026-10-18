import { Alert, Button } from 'antd'
import { useTranslation } from 'react-i18next'
import { describeError, isNotFound } from '../lib/errors'

interface QueryErrorProps {
  error: unknown
  onRetry?: () => void
}

/** Error state for failed queries: a visible alert and a retry button (no silent empty UI). */
export function QueryError({ error, onRetry }: QueryErrorProps) {
  const { t } = useTranslation()
  const message = isNotFound(error)
    ? t('common.notFound')
    : errorText(error, t)
  return (
    <Alert
      type="error"
      showIcon
      message={message}
      action={
        onRetry && !isNotFound(error) ? (
          <Button size="small" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : undefined
      }
    />
  )
}
