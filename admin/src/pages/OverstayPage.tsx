import { Alert, Space } from 'antd'
import { useTranslation } from 'react-i18next'
import { BookingsView } from '../components/BookingsView'

const DUE = { overstay_status: 'due' } as const

/** Overstay charges not yet collected at the gate (docs 10.7, 9.2 "due"). */
export default function OverstayPage() {
  const { t } = useTranslation()
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert type="info" showIcon message={t('overstay.hint')} />
      <BookingsView title={t('overstay.title')} preset={DUE} exportName="overstay-due" />
    </Space>
  )
}
