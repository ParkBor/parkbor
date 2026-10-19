import type { AdminRefund, RefundOutcome } from '@habi/api-client'
import { ApiError } from '@habi/api-client'
import { Alert, Checkbox, Input, Modal, Radio, Space, Typography, message } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorText } from '../lib/errorText'
import { apiErrorCode } from '../lib/errors'
import { formatMoney } from '../lib/format'
import { useSingleFlight } from '../lib/useSingleFlight'
import { allowedOutcomes, checkRefundNote, REFUND_NOTE_MAX } from '../lib/refundNote'

interface RefundResolveModalProps {
  refund: AdminRefund | null
  /** Resolves with the saved refund or rejects with the ApiError (shown inside the modal). */
  onResolve: (refundId: string, outcome: RefundOutcome, note: string) => Promise<unknown>
  onClose: () => void
  /** The refund changed or vanished under us: refetch the queue. */
  onStale?: () => void
}

const STALE_CODES = ['invalid_transition', 'not_found']
const KNOWN_CODES = ['reservation_mismatch', 'invalid_transition', 'validation_error', 'not_found']

/**
 * A person settles a MANUAL or FAILED refund (docs 8.4). Which outcomes exist depends on the
 * status; the money-affecting `failed` outcome is final and needs an explicit confirmation text.
 */
export function RefundResolveModal({ refund, onResolve, onClose, onStale }: RefundResolveModalProps) {
  if (refund === null) return null
  return (
    <ResolveForm key={refund.id} refund={refund} onResolve={onResolve} onClose={onClose} onStale={onStale} />
  )
}

function ResolveForm({
  refund,
  onResolve,
  onClose,
  onStale,
}: Omit<RefundResolveModalProps, 'refund'> & { refund: AdminRefund }) {
  const { t } = useTranslation()
  const outcomes = allowedOutcomes(refund)
  // No pre-selected outcome: the person must choose (and, for the money-affecting ones, confirm).
  const [outcome, setOutcome] = useState<RefundOutcome | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = checkRefundNote(note)
  const needsConfirm = outcome === 'done' || outcome === 'failed'
  const ready = outcome !== null && problem === null && (!needsConfirm || confirmed)

  const singleFlight = useSingleFlight()

  function submit() {
    if (!ready || busy || outcome === null) return
    void singleFlight(() => run(outcome))
  }

  async function run(outcome: RefundOutcome) {
    setBusy(true)
    setError(null)
    try {
      await onResolve(refund.id, outcome, note.trim())
      onClose()
    } catch (cause) {
      const code = apiErrorCode(cause)
      if ((code && STALE_CODES.includes(code)) || (cause instanceof ApiError && cause.status === 404)) {
        void message.warning(t('refunds.stale'))
        onStale?.()
        onClose()
        return
      }
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
      okButtonProps={{ disabled: !ready, loading: busy }}
      onOk={submit}
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
          <Radio.Group
            aria-label={t('refunds.outcomeLabel')}
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value as RefundOutcome)
              setConfirmed(false)
            }}
          >
            <Space direction="vertical">
              {outcomes.map((value) => (
                <Radio key={value} value={value}>
                  {t(`refunds.outcomes.${value}`)}
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        )}
        {outcome === null && outcomes.length > 0 ? (
          <Typography.Text type="secondary">{t('refunds.chooseOutcome')}</Typography.Text>
        ) : null}
        {needsConfirm ? (
          <Checkbox checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)}>
            {t(outcome === 'failed' ? 'refunds.confirmFailed' : 'refunds.confirmDone')}
          </Checkbox>
        ) : null}
        {outcome === 'failed' ? <Alert type="warning" showIcon message={t('refunds.failedWarning')} /> : null}
        {outcome === 'retry' && (refund.last_error ?? '').startsWith('click_error') ? (
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
        <div aria-live="polite">
          <Typography.Text type={problem ? 'danger' : 'secondary'}>
            {problem ? t(`refunds.noteProblems.${problem}`) : t('refunds.noteHint')}
          </Typography.Text>
        </div>
        {error ? <Alert type="error" showIcon role="alert" message={error} /> : null}
      </Space>
    </Modal>
  )
}
