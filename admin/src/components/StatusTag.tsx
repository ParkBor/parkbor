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

/** Known server values per kind: only these are looked up in the translations. */
const KNOWN: Record<StatusKind, Record<string, string>> = {
  booking: {
    PENDING_PAYMENT: 'gold',
    CONFIRMED: 'blue',
    ACTIVE: 'green',
    OVERSTAY: 'volcano',
    COMPLETED: 'default',
    CANCELLED: 'default',
    EXPIRED: 'default',
    NO_SHOW: 'default',
  },
  payment: {
    CREATED: 'default',
    PENDING: 'gold',
    PAID: 'green',
    CANCELLED: 'default',
    REFUNDED: 'purple',
    FAILED: 'red',
  },
  refund: { PENDING: 'gold', SENT: 'blue', DONE: 'green', FAILED: 'red', MANUAL: 'orange' },
  refundView: { none: 'default', pending: 'gold', done: 'green', manual: 'orange', failed: 'red' },
  overstay: { none: 'default', due: 'red', collected: 'green', waived: 'default' },
  review: { PUBLISHED: 'green', HIDDEN: 'default' },
  role: { DRIVER: 'default', OPERATOR: 'cyan', OWNER: 'blue', ADMIN: 'red' },
}

interface StatusTagProps {
  kind: StatusKind
  value: string
}

/**
 * A coloured, translated status. A value the panel does not know is shown as sanitised plain text
 * and never used to build a translation key.
 */
export function StatusTag({ kind, value }: StatusTagProps) {
  const { t } = useTranslation()
  const colors = KNOWN[kind]
  if (typeof value === 'string' && Object.hasOwn(colors, value)) {
    return <Tag color={colors[value]}>{t(`status.${kind}.${value}`)}</Tag>
  }
  return <Tag>{safeText(value, 40)}</Tag>
}
