import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import type { BookingStatus } from '@/features/booking/bookingSchemas';
import { statusView, toneColor } from '@/features/booking/statusView';
import { usePalette } from '@/theme/theme';

/** Status pill: colour AND glyph AND text, so the state never depends on colour alone. */
export function StatusChip({ status }: { status: BookingStatus }) {
  const { t } = useTranslation();
  const p = usePalette();
  const view = statusView(status);
  const color = toneColor(view.tone, p);
  return (
    <View style={[styles.chip, { borderColor: color }]} accessible accessibilityLabel={t('booking.detail.statusLabel', { status: t(view.labelKey) })}>
      <Text accessible={false} style={[styles.glyph, { color }]}>
        {view.glyph}
      </Text>
      <Text accessible={false} style={[styles.label, { color }]}>
        {t(view.labelKey)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  glyph: { fontSize: 14, fontWeight: '700' },
  label: { fontSize: 13, fontWeight: '700' },
});
