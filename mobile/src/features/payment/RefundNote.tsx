import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import type { Booking } from '@/features/booking/bookingSchemas';
import { toneColor, type StatusTone } from '@/features/booking/statusView';
import { formatPrice } from '@/features/map/format';
import { useLanguage } from '@/features/map/useLanguage';
import { refundView, type RefundTone } from '@/features/payment/refundView';
import { usePalette } from '@/theme/theme';

const TONE: Readonly<Record<RefundTone, StatusTone>> = { success: 'success', warning: 'warning', error: 'error', muted: 'muted' };

/**
 * What happened to the refund. The amount is a PROMISE until the status is `done`
 * (the label says so); nothing is shown when no refund was promised or started.
 */
export function RefundNote({ booking }: { booking: Pick<Booking, 'refundAmount' | 'refundStatus'> }) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const view = refundView(booking.refundStatus, booking.refundAmount);
  if (view === null) return null;
  const amount = view.hasAmount ? (formatPrice(booking.refundAmount, lang) ?? booking.refundAmount) : null;
  return (
    <View style={[styles.box, { backgroundColor: p.surface, borderColor: p.border }]} accessibilityLiveRegion="polite">
      {amount ? (
        <View style={styles.row}>
          <Text style={{ color: p.textMuted }}>{t(view.amountLabelKey)}</Text>
          <Text style={[styles.value, { color: p.text }]}>{amount}</Text>
        </View>
      ) : null}
      <Text style={{ color: toneColor(TONE[view.tone], p) }}>{t(view.textKey)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  value: { fontWeight: '600' },
});
