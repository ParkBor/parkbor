import { Alert, Button, Input, Modal, Space, Typography } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDateTime, safeText } from '../lib/format'

interface InviteCodeModalProps {
  /** The one-time code. It lives only in this component's props: close it and it is gone. */
  code: string | null
  expiresAt: string | null
  onClose: () => void
}

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Shows an operator invitation code ONCE. The server keeps only a hash, so there is no way to
 * show it again. Escape, the backdrop and a close icon are all disabled: the dialog closes only
 * through its button, so a stray key press cannot discard the only copy.
 */
export function InviteCodeModal({ code, expiresAt, onClose }: InviteCodeModalProps) {
  if (code === null) return null
  return <CodeDialog code={code} expiresAt={expiresAt} onClose={onClose} />
}

function CodeDialog({
  code,
  expiresAt,
  onClose,
}: {
  code: string
  expiresAt: string | null
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const [copy, setCopy] = useState<CopyState>('idle')
  const shown = safeText(code, 100)

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(shown)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <Modal
      open
      title={t('operators.codeTitle')}
      closable={false}
      keyboard={false}
      maskClosable={false}
      destroyOnHidden
      footer={
        <Button type="primary" onClick={onClose}>
          {t('operators.codeClose')}
        </Button>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="warning" showIcon message={t('operators.codeOnce')} />
        <Space.Compact style={{ width: '100%' }}>
          <Input
            readOnly
            value={shown}
            aria-label={t('operators.code')}
            onFocus={(event) => event.target.select()}
          />
          <Button onClick={() => void copyCode()}>{t('operators.copy')}</Button>
        </Space.Compact>
        <output aria-live="polite">
          {copy === 'copied' ? <Typography.Text type="success">{t('operators.copied')}</Typography.Text> : null}
          {copy === 'failed' ? <Typography.Text type="danger">{t('operators.copyFailed')}</Typography.Text> : null}
        </output>
        {expiresAt ? (
          <Typography.Text type="secondary">
            {t('operators.expiresAt')}: {formatDateTime(expiresAt, i18n.language)}
          </Typography.Text>
        ) : null}
      </Space>
    </Modal>
  )
}
