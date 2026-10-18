import { Tag } from 'antd'
import { useTranslation } from 'react-i18next'
import { safeText } from '../lib/format'

export type StatusKind =
  | 'booking'
  | 'payment'
  | 'refund'
  | 'refundView'
  | 'overstay'
  | 'review'
  | 'role'

const COLORS: Record<string, string> = {
  PENDING_PAYMENT: 'gold',
  CONFIRMED: 'blue',
  ACTIVE: 'green',
  OVERSTAY: 'volcano',
  PENDING: 'gold',
  PAID: 'green',
  REFUNDED: 'purple',
  FAILED: 'red',
  SENT: 'blue',
  DONE: 'green',
  MANUAL: 'orange',
  pending: 'gold',
  done: 'green',
  manual: 'orange',
  failed: 'red',
  due: 'red',
  collected: 'green',
  PUBLISHED: 'green',
  ADMIN: 'red',
  OWNER: 'blue',
  OPERATOR: 'cyan',
}

interface StatusTagProps {
  kind: StatusKind
  value: string
}

/** A coloured, translated status. An unknown server value is shown as sanitised plain text. */
export function StatusTag({ kind, value }: StatusTagProps) {
  const { t } = useTranslation()
  const text = safeText(value, 40)
  return (
    <Tag color={COLORS[value] ?? 'default'}>
      {t(`status.${kind}.${text}`, { defaultValue: text })}
    </Tag>
  )
}
