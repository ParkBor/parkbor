import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { BookingActions } from '@/features/booking/BookingActions';
import { BookingSummary } from '@/features/booking/BookingSummary';
import { classifyBookingError } from '@/features/booking/bookingErrors';
import { resolveBookingParam } from '@/features/booking/deepLink';
import { QrPanel } from '@/features/booking/QrPanel';
import { canShowQr } from '@/features/booking/statusView';
import { useBooking } from '@/features/booking/useBookings';
import { loadState } from '@/lib/loadState';
import { usePalette } from '@/theme/theme';

/** booking/[id]: status, slot, time, amount, timer, QR (CONFIRMED | ACTIVE) and actions. */
export function BookingDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const target = resolveBookingParam(params.id);

  // parkbor://booking/<garbage>: nothing to show, go to the list.
  useEffect(() => {
    if (!target.ok) router.replace('/(tabs)/bookings');
  }, [target.ok, router]);

  return target.ok ? <BookingDetail id={target.id} /> : null;
}

function BookingDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const query = useBooking(id);
  const booking = query.data;
  const state = loadState({
    hasData: booking !== undefined,
    isPending: query.isPending,
    isError: query.isError,
    fetchStatus: query.fetchStatus,
  });

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: p.background }]}>
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />}
      >
        <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
          {t('booking.detail.title')}
        </Text>
        {state === 'loading' ? (
          <View style={styles.center}>
            <ActivityIndicator color={p.primary} />
            <Text style={{ color: p.textMuted }}>{t('booking.detail.loading')}</Text>
          </View>
        ) : null}
        {state === 'offline' || state === 'error' ? (
          <FailureView state={state} error={query.error} onRetry={() => void query.refetch()} />
        ) : null}
        {booking ? (
          <>
            {query.isError ? <Text style={{ color: p.warningText }}>{t('booking.detail.offlineData')}</Text> : null}
            <BookingSummary booking={booking} />
            {canShowQr(booking.status) ? <QrPanel bookingId={booking.id} startMs={booking.startMs} /> : null}
            <BookingActions booking={booking} />
          </>
        ) : null}
        <Button
          variant="secondary"
          label={t('common.back')}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/bookings'))}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function FailureView({ state, error, onRetry }: { state: 'offline' | 'error'; error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  const failure = state === 'error' ? classifyBookingError(error) : null;
  return (
    <View style={styles.center}>
      <ErrorText message={failure ? t(failure.key) : t('common.offline')} />
      {failure === null || failure.retry !== 'none' ? <Button variant="secondary" label={t('common.retry')} onPress={onRetry} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { padding: 24, gap: 14 },
  title: { fontSize: 24, fontWeight: '700' },
  center: { gap: 8, alignItems: 'center', paddingVertical: 24 },
});
