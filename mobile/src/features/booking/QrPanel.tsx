import { useQueryClient } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from 'expo-screen-capture';
import { useTranslation } from 'react-i18next';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { bookingKeys } from '@/features/booking/queryKeys';
import { isQrActive } from '@/features/booking/qrSource';
import { serverClock } from '@/features/booking/serverClock';
import { useQrBrightness } from '@/features/booking/useQrBrightness';
import { useQrToken } from '@/features/booking/useQrToken';
import { usePalette } from '@/theme/theme';
import { useScreenLayout } from '@/theme/useScreenLayout';

const MAX_QR_SIZE = 320;
const MAX_QR_SHORT = 220;
/** Card padding + border on both sides of the QR tile. */
const QR_SIDE_MARGIN = 56;
const SCREEN_CAPTURE_KEY = 'habi-booking-qr';

/** Mounted only while a QR can be shown (CONFIRMED | ACTIVE). */
export function QrPanel({ bookingId, startMs }: { bookingId: string; startMs: number }) {
  const { t } = useTranslation();
  const p = usePalette();
  const { innerWidth, isShort } = useScreenLayout();
  const isFocused = useIsFocused();
  const qr = useQrToken(bookingId, true);
  const queryClient = useQueryClient();
  const { problem } = qr;
  // 409 qr_not_available: the booking is no longer CONFIRMED/ACTIVE - reload it so the screen follows.
  useEffect(() => {
    if (problem === 'unavailable') void queryClient.invalidateQueries({ queryKey: bookingKeys.detail(bookingId) });
  }, [problem, bookingId, queryClient]);

  // Screenshots / screen recording / the app-switcher preview are blocked while this panel exists.
  // Why: the QR is a bearer credential for entry. It is single-use (the first scan wins), so a
  // leaked screenshot lets a third party race the owner at the gate; blocking capture removes
  // the easy copy. A person looking over the shoulder remains possible by nature of a QR.
  // Tied to focus (like the brightness): while another screen is pushed on top of this one, it is
  // not blocked.
  useEffect(() => {
    if (!isFocused) return undefined;
    void preventScreenCaptureAsync(SCREEN_CAPTURE_KEY).catch(() => undefined);
    return () => void allowScreenCaptureAsync(SCREEN_CAPTURE_KEY).catch(() => undefined);
  }, [isFocused]);
  useQrBrightness(isFocused && qr.data !== undefined);

  const isActive = isQrActive(startMs, serverClock.now());
  // Inside the padded, width-capped column; smaller in landscape / split screen so it fits without scrolling far.
  const size = Math.min(isShort ? MAX_QR_SHORT : MAX_QR_SIZE, Math.max(160, innerWidth - QR_SIDE_MARGIN));

  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('booking.qr.title')}
      </Text>
      {qr.data ? (
        <>
          {/* White tile in both themes: a dark QR on a dark background does not scan. */}
          <View testID="booking-qr" style={styles.tile} accessible accessibilityRole="image" accessibilityLabel={t('booking.qr.label')}>
            <QRCode value={qr.data.token} size={size} ecl="M" quietZone={8} color="#000000" backgroundColor="#FFFFFF" />
          </View>
          <Text style={{ color: p.textMuted }}>{t('booking.qr.hint')}</Text>
          {!isActive ? <Text style={{ color: p.warningText }}>{t('booking.qr.notYetValid')}</Text> : null}
          {qr.data.isFromDevice ? <Text style={{ color: p.warningText }}>{t('booking.qr.offline')}</Text> : null}
          <Text style={[styles.note, { color: p.textMuted }]}>{t('booking.qr.secure')}</Text>
        </>
      ) : qr.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator color={p.primary} />
          <Text style={{ color: p.textMuted }}>{t('booking.qr.loading')}</Text>
        </View>
      ) : (
        <View style={styles.center}>
          {qr.problem === 'unavailable' ? (
            <Text style={{ color: p.text }}>{t('booking.qr.unavailable')}</Text>
          ) : (
            <ErrorText message={t('booking.qr.error')} />
          )}
          {qr.problem !== 'unavailable' ? (
            <Button variant="secondary" label={t('booking.qr.retry')} onPress={() => void qr.refetch()} />
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 12, alignItems: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  tile: { backgroundColor: '#FFFFFF', padding: 8, borderRadius: 12 },
  center: { gap: 8, alignItems: 'center', paddingVertical: 12 },
  note: { fontSize: 12, textAlign: 'center' },
});
