import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import type { SlotAvailability } from '@/features/parking/useSlotAvailability';
import { usePalette } from '@/theme/theme';

/** Free spots per spot type, with loading / offline / error states. */
export function SlotRows({ slots }: { slots: SlotAvailability }) {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <>
      <Text accessibilityRole="header" style={[styles.section, { color: p.text }]}>
        {t('parking.slots')}
      </Text>
      <Text style={[styles.hint, { color: p.textMuted }]}>{t('parking.slotsFor')}</Text>
      {slots.isLoading ? <Text style={{ color: p.textMuted }}>{t('parking.slotsLoading')}</Text> : null}
      {slots.isOffline ? <Text style={{ color: p.warningText }}>{t('common.offline')}</Text> : null}
      {slots.hasError ? <Text style={{ color: p.error }}>{t('parking.slotsError')}</Text> : null}
      {slots.rows.map((row) => (
        <View key={row.slotType} style={styles.row}>
          <Text style={{ color: p.text }}>{t(`map.slot.${row.slotType}`)}</Text>
          <Text style={{ color: row.isFull || !row.isOpen ? p.error : p.successText, fontWeight: '700' }}>
            {!row.isOpen ? t('parking.closedNow') : row.isFull ? t('parking.full') : t('parking.free', { free: row.available, total: row.total })}
          </Text>
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  hint: { fontSize: 13 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
});
