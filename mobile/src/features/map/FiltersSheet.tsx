import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { RADIUS_OPTIONS_M } from '@/features/map/filters';
import { filtersStore, useFiltersStore } from '@/features/map/filtersStore';
import { formatDistance } from '@/features/map/format';
import { SLOT_TYPES, SORT_MODES } from '@/features/map/schemas';
import { useLanguage } from '@/features/map/useLanguage';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface FiltersSheetProps {
  visible: boolean;
  onClose: () => void;
}

/** Bottom sheet with radius, spot type, sorting and "open only". Changes apply immediately. */
export function FiltersSheet({ visible, onClose }: FiltersSheetProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const lang = useLanguage();
  const insets = useSafeAreaInsets();
  const filters = useFiltersStore((s) => s.filters);
  const actions = filtersStore.getState();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable
          style={styles.dismiss}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('map.filter.close')}
        />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { backgroundColor: p.background, paddingBottom: insets.bottom + 16 }]}
        >
          <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
            {t('map.filter.title')}
          </Text>
          <ScrollView contentContainerStyle={styles.body}>
            <Text accessibilityRole="header" style={[styles.group, { color: p.text }]}>
              {t('map.filter.radius')}
            </Text>
            <View style={styles.row}>
              {RADIUS_OPTIONS_M.map((radius) => (
                <Chip
                  key={radius}
                  label={formatDistance(radius, lang)}
                  selected={filters.radiusM === radius}
                  onPress={() => actions.setRadius(radius)}
                />
              ))}
            </View>

            <Text accessibilityRole="header" style={[styles.group, { color: p.text }]}>
              {t('map.filter.slotType')}
            </Text>
            <View style={styles.row}>
              <Chip
                label={t('map.filter.allSlots')}
                selected={filters.slotType === null}
                onPress={() => actions.setSlotType(null)}
              />
              {SLOT_TYPES.map((slot) => (
                <Chip
                  key={slot}
                  label={t(`map.slot.${slot}`)}
                  selected={filters.slotType === slot}
                  onPress={() => actions.setSlotType(slot)}
                />
              ))}
            </View>

            <Text accessibilityRole="header" style={[styles.group, { color: p.text }]}>
              {t('map.sort.title')}
            </Text>
            <View style={styles.row}>
              {SORT_MODES.map((mode) => (
                <Chip
                  key={mode}
                  label={t(`map.sort.${mode}`)}
                  selected={filters.sort === mode}
                  onPress={() => actions.setSort(mode)}
                />
              ))}
            </View>

            <View style={styles.row}>
              <Chip
                role="checkbox"
                label={t('map.filter.onlyOpen')}
                selected={filters.onlyOpen}
                onPress={() => actions.setOnlyOpen(!filters.onlyOpen)}
              />
            </View>
          </ScrollView>
          <View style={styles.actions}>
            <View style={styles.action}>
              <Button variant="secondary" label={t('map.filter.reset')} onPress={actions.reset} />
            </View>
            <View style={styles.action}>
              <Button label={t('map.filter.done')} onPress={onClose} />
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  dismiss: { flex: 1, minHeight: MIN_TOUCH },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 16, maxHeight: '85%' },
  title: { fontSize: 20, fontWeight: '700', paddingHorizontal: 16 },
  body: { padding: 16, gap: 12 },
  group: { fontSize: 15, fontWeight: '700', marginTop: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actions: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 8 },
  action: { flex: 1 },
});
