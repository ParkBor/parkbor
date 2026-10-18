import { useTranslation } from 'react-i18next'
import { BookingsView } from '../components/BookingsView'

export default function BookingsPage() {
  const { t } = useTranslation()
  return <BookingsView title={t('bookings.title')} exportName="bookings" />
}
