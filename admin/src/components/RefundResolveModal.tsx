import type { AdminRefund, RefundOutcome } from '@habi/api-client'
import { Alert, Input, Modal, Radio, Space, Typography } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '../lib/errorText'
import { apiErrorCode } from '../lib/errors'
import { formatMoney } from '../lib/format'
import { allowedOutcomes, checkRefundNote, REFUND_NOTE_MAX } from '../lib/refundNote'

interface RefundResolveModalProps {
  refund: AdminRefund | null
  /** Resolves with the saved refund or rejects with the ApiError (shown inside the modal). */
  onResolve: (refundId: string, outcome: RefundOutcome, note: string) => Promise<unknown>
  onClose: () => void
}

const KNOWN_CODES = ['reservation_mismatch', 'invalid_transition', 'validation_error', 'not_found']

/**
 * A person settles a MANUAL or FAILED refund (docs 8.4). Which outcomes exist depends on the
 * status; the money-affecting `failed` outcome is final and needs an explicit confirmation text.
 */
export function RefundResolveModal({ refund, onResolve, onClose }: RefundResolveModalProps) {
  if (refund === null) return null
  return <ResolveForm key={refund.id} refund={refund} onResolve={onResolve} onClose={onClose} />
}

function ResolveForm({
  refund,
  onResolve,
  onClose,
}: Omit<RefundResolveModalProps, 'refund'> & { refund: AdminRefund }) {
  const { t } = useTranslation()
  const outcomes = allowedOutcomes(refund)
  const [outcome, setOutcome] = useState<RefundOutcome | null>(outcomes[0] ?? null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = checkRefundNote(note)

  async function submit() {
    if (outcome === null || problem !== null || busy) return
    setBusy(true)
    setError(null)
    try {
      await onResolve(refund.id, outcome, note.trim())
      onClose()
    } catch (cause) {
      const code = apiErrorCode(cause)
      setError(
        code && KNOWN_CODES.includes(code)
          ? t(`refunds.errors.${code}`)
          : errorText(cause, t),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={t('refunds.resolveTitle')}
      okText={t('refunds.confirm')}
      cancelText={t('common.cancel')}
      okButtonProps={{ disabled: outcome === null || problem !== null, loading: busy }}
      onOk={() => void submit()}
      onCancel={onClose}
      maskClosable={false}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text>
          {t('refunds.amount')}: {formatMoney(refund.amount)}
        </Typography.Text>
        {outcomes.length === 0 ? (
          <Alert type="info" showIcon message={t('refunds.final')} />
        ) : (
          <Radio.Group value={outcome} onChange={(event) => setOutcome(event.target.value as RefundOutcome)}>
            <Space direction="vertical">
              {outcomes.map((value) => (
                <Radio key={value} value={value}>
                  {t(`refunds.outcomes.${value}`)}
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        )}
        {outcome === 'failed' ? <Alert type="warning" showIcon message={t('refunds.failedWarning')} /> : null}
        {outcome === 'retry' && refund.last_error.startsWith('click_error') ? (
          <Alert type="warning" showIcon message={t('refunds.checkClickFirst')} />
        ) : null}
        <label htmlFor="refund-note">{t('refunds.note')}</label>
        <Input.TextArea
          id="refund-note"
          value={note}
          rows={3}
          maxLength={REFUND_NOTE_MAX + 50}
          onChange={(event) => setNote(event.target.value)}
          status={problem ? 'error' : undefined}
        />
        <Typography.Text type={problem ? 'danger' : 'secondary'}>
          {problem ? t(`refunds.noteProblems.${problem}`) : t('refunds.noteHint')}
        </Typography.Text>
        {error ? <Alert type="error" showIcon role="alert" message={error} /> : null}
      </Space>
    </Modal>
  )
}
