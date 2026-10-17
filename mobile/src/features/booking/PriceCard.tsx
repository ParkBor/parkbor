import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { classifyBookingError } from '@/features/booking/bookingErrors';
import { derivePriceRows } from '@/features/booking/priceRows';
import type { Price } from '@/features/booking/quoteSchemas';
import { useLanguage } from '@/features/map/useLanguage';
import { usePalette } from '@/theme/theme';

interface PriceCardProps {
  price: Price | undefined;
  isLoading: boolean;
  /** The price on screen belongs to a previous selection: dimmed and marked as updating. */
  isStale: boolean;
  error: unknown;
  onRetry: () => void;
}

/** Live breakdown from GET /parkings/{id}/price; amounts are the server's, never recomputed here. */
export function PriceCard({ price, isLoading, isStale, error, onRetry }: PriceCardProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const view = price ? derivePriceRows(price, lang) : null;
  const failure = error ? classifyBookingError(error) : null;

  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border, opacity: isStale ? 0.5 : 1 }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('booking.form.priceTitle')}
      </Text>
      {isStale ? (
        <Text accessibilityLiveRegion="polite" style={{ color: p.warningText }}>
          {t('booking.form.updatingPrice')}
        </Text>
      ) : null}
      {view ? (
        <>
          {view.perHour ? <Text style={{ color: p.textMuted }}>{view.perHour}</Text> : null}
          {view.rows.map((row, index) => (
            <View key={`${row.kind}-${index}`} style={styles.row}>
              <Text style={{ color: row.isPeak ? p.warningText : p.text, flexShrink: 1 }}>
                {row.kind === 'dynamic'
                  ? t('booking.form.dynamic', row.params)
                  : t(row.isPeak ? 'booking.form.segmentPeak' : 'booking.form.segmentBase', row.params)}
              </Text>
              <Text style={{ color: p.text }}>{row.amount}</Text>
            </View>
          ))}
          {view.freeMinutes > 0 ? (
            <Text style={{ color: p.successText }}>{t('booking.form.freeMinutes', { minutes: view.freeMinutes })}</Text>
          ) : null}
          <View style={[styles.row, styles.total]}>
            <Text style={[styles.totalText, { color: p.text }]}>{t('booking.form.total')}</Text>
            <Text style={[styles.totalText, { color: p.text }]} accessibilityLiveRegion="polite">
              {view.total}
            </Text>
          </View>
          <Text style={[styles.note, { color: p.textMuted }]}>{t('booking.form.priceIndicative')}</Text>
        </>
      ) : isLoading ? (
        <View style={styles.row}>
          <ActivityIndicator color={p.primary} />
          <Text style={{ color: p.textMuted }}>{t('booking.form.priceLoading')}</Text>
        </View>
      ) : null}
      {failure ? (
        <>
          <ErrorText message={t(failure.key)} />
          <Button variant="secondary" label={t('booking.form.priceRetry')} onPress={onRetry} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  title: { fontSize: 17, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  total: { marginTop: 4 },
  totalText: { fontSize: 18, fontWeight: '700' },
  note: { fontSize: 12 },
});
