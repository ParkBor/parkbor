import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useIsAuthenticated } from '@/features/booking/useAuthenticated';
import { useServerNow } from '@/features/booking/useServerNow';
import { getLastPaymentBookingId } from '@/features/payment/lastPayment';
import { parsePaymentResultParams } from '@/features/payment/paymentResult';
import { holdHasLapsed, type PollPhase } from '@/features/payment/paymentPolling';
import { RefundNote } from '@/features/payment/RefundNote';
import { usePaymentCheck } from '@/features/payment/usePaymentCheck';
import { useNotificationPrompt } from '@/features/push/usePushPrompt';
import { usePalette } from '@/theme/theme';

const AUTO_OPEN_DELAY_MS = 2000;
const CLOCK_TICK_MS = 1000;

/**
 * payment/result = `parkbor://payment/result`. Reached from the payment WebView and from outside the
 * app (external browser / provider app). The link is only a signal: its status is ignored, a
 * booking id is used only if it is a UUID (else the booking last paid in this app run, else the
 * bookings list). The outcome comes from the SERVER booking via polling.
 */
export function PaymentResultScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const bookingId = useMemo(
    () => parsePaymentResultParams(params).bookingId ?? getLastPaymentBookingId(),
    [params],
  );

  useEffect(() => {
    if (bookingId === null) router.replace('/(tabs)/bookings');
  }, [bookingId, router]);

  // key: a different booking id is a fresh check (state never carries over).
  return bookingId === null ? null : <PaymentResult key={bookingId} id={bookingId} />;
}

function PaymentResult({ id }: { id: string }) {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const now = useServerNow(CLOCK_TICK_MS);
  const isAuthenticated = useIsAuthenticated();
  const { state, booking, recheck } = usePaymentCheck(id, isAuthenticated);
  const { phase } = state;
  // Right after the payment was confirmed is the moment notifications are worth asking for
  // (reminder before the time ends, changes). An old CONFIRMED booking opened later is not.
  useNotificationPrompt(phase === 'paid');

  const openBooking = (): void => router.dismissTo({ pathname: '/booking/[id]', params: { id } });
  const openList = (): void => router.replace('/(tabs)/bookings');

  // Paid: show the success for a moment, then the booking (QR).
  useEffect(() => {
    if (phase !== 'paid') return undefined;
    const timer = setTimeout(() => router.dismissTo({ pathname: '/booking/[id]', params: { id } }), AUTO_OPEN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phase, id, router]);

  return (
    <Screen isScrollable>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('payment.result.title')}
      </Text>
      <View style={styles.center} accessibilityLiveRegion="polite">
        {phase === 'checking' ? <ActivityIndicator color={p.primary} size="large" accessibilityLabel={t('payment.result.checking')} /> : null}
        <Text style={[styles.headline, { color: headlineColor(phase, p) }]}>{t(`payment.result.${phase}`)}</Text>
        <Text style={[styles.hint, { color: p.textMuted }]}>{t(`payment.result.${phase}Hint`)}</Text>
        {phase === 'checking' && holdHasLapsed(state, now) ? (
          <Text style={{ color: p.warningText }}>{t('payment.result.holdLapsed')}</Text>
        ) : null}
        {phase === 'rejected' && booking ? <RefundNote booking={booking} /> : null}
      </View>
      {phase === 'paid' ? <Button label={t('payment.result.viewBooking')} onPress={openBooking} /> : null}
      {phase === 'timeout' || phase === 'failed' ? <Button label={t('payment.result.recheck')} onPress={recheck} /> : null}
      {phase !== 'paid' ? <Button variant="secondary" label={t('payment.result.toBookings')} onPress={openList} /> : null}
      {phase === 'rejected' ? <Button variant="secondary" label={t('payment.webview.viewBooking')} onPress={openBooking} /> : null}
    </Screen>
  );
}

function headlineColor(phase: PollPhase, p: ReturnType<typeof usePalette>): string {
  if (phase === 'paid') return p.successText;
  if (phase === 'rejected' || phase === 'failed') return p.error;
  if (phase === 'timeout') return p.warningText;
  return p.text;
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700' },
  center: { alignItems: 'center', gap: 12, paddingVertical: 24 },
  headline: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  hint: { textAlign: 'center' },
});
