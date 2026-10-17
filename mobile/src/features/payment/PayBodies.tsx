import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import type { Booking } from '@/features/booking/bookingSchemas';
import { CountdownLine } from '@/features/booking/CountdownLine';
import type { PayAvailability } from '@/features/payment/payAvailability';
import { usePalette } from '@/theme/theme';

/** Title and the hold countdown. The countdown ticks inside its own component: the screen does not re-render. */
export function PayHeader({ booking }: { booking: Booking | undefined }) {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <View style={styles.header}>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('payment.webview.title')}
      </Text>
      {booking ? <CountdownLine booking={booking} /> : null}
    </View>
  );
}

export function SecureNote() {
  const { t } = useTranslation();
  const p = usePalette();
  return <Text style={[styles.note, { color: p.textMuted }]}>{t('payment.webview.secure')}</Text>;
}

interface PayFooterProps {
  onCheckStatus: () => void;
  onCancelPayment: () => void;
}

export function PayFooter({ onCheckStatus, onCancelPayment }: PayFooterProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.footer}>
      <Button variant="secondary" label={t('payment.webview.checkStatus')} onPress={onCheckStatus} />
      <Button variant="secondary" label={t('payment.webview.cancelPayment')} onPress={onCancelPayment} />
    </View>
  );
}

interface LoadFailure {
  state: 'loading' | 'offline' | 'error' | 'ready';
  messageKey: string | null;
  onRetry: () => void;
}

interface PayUnavailableProps {
  availability: PayAvailability | null;
  failure: LoadFailure;
  /** Offer cancelling only when a booking is known and its hold may still be alive. */
  canCancel: boolean;
  onViewBooking: () => void;
  onCancel: () => void;
}

/** Everything shown instead of the payment page: loading, load failure, or why the booking cannot be paid. */
export function PayUnavailable({ availability, failure, canCancel, onViewBooking, onCancel }: PayUnavailableProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const hasBooking = availability !== null;
  return (
    <View style={styles.center}>
      {!hasBooking && failure.state === 'loading' ? <ActivityIndicator color={p.primary} accessibilityLabel={t('payment.webview.loading')} /> : null}
      {!hasBooking && failure.messageKey !== null ? <ErrorText message={t(failure.messageKey)} /> : null}
      {!hasBooking && failure.state !== 'loading' ? <Button variant="secondary" label={t('common.retry')} onPress={failure.onRetry} /> : null}
      {availability !== null && availability.kind !== 'ready' ? (
        <>
          <ErrorText message={t(`payment.unavailable.${availability.kind}`)} />
          <Button label={t('payment.webview.viewBooking')} onPress={onViewBooking} />
          {canCancel && availability.kind !== 'hold_over' ? (
            <Button variant="secondary" label={t('booking.detail.cancel')} onPress={onCancel} />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 24, paddingTop: 12, gap: 4 },
  title: { fontSize: 22, fontWeight: '700' },
  note: { fontSize: 12, paddingHorizontal: 24, paddingVertical: 4 },
  footer: { padding: 12, gap: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
});
