import { Alert, Button, Input, Modal, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { formatDateTime, safeText } from '../lib/format'

interface InviteCodeModalProps {
  /** The one-time code. It lives only in this component's props: close it and it is gone. */
  code: string | null
  expiresAt: string | null
  onClose: () => void
}

/**
 * Shows an operator invitation code ONCE. The server keeps only a hash, so there is no way to
 * show it again; closing the dialog drops the only copy held by the browser.
 */
export function InviteCodeModal({ code, expiresAt, onClose }: InviteCodeModalProps) {
  const { t, i18n } = useTranslation()
  if (code === null) return null
  const shown = safeText(code, 100)

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown)
    } catch {
      // clipboard blocked: the code is selectable in the field
    }
  }

  return (
    <Modal
      open
      title={t('operators.codeTitle')}
      onCancel={onClose}
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
          <Input readOnly value={shown} aria-label={t('operators.code')} />
          <Button onClick={() => void copy()}>{t('operators.copy')}</Button>
        </Space.Compact>
        {expiresAt ? (
          <Typography.Text type="secondary">
            {t('operators.expiresAt')}: {formatDateTime(expiresAt, i18n.language)}
          </Typography.Text>
        ) : null}
      </Space>
    </Modal>
  )
}
