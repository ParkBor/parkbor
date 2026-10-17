import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { Chip } from '@/components/Chip';
import { SLOT_TYPES, type SlotType } from '@/features/map/schemas';
import { usePalette } from '@/theme/theme';

interface SlotTypePickerProps {
  selected: SlotType;
  onSelect: (slotType: SlotType) => void;
}

export function SlotTypePicker({ selected, onSelect }: SlotTypePickerProps) {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <View style={styles.root}>
      <Text style={{ color: p.text }}>{t('booking.form.slotType')}</Text>
      <View style={styles.chips} accessibilityRole="radiogroup">
        {SLOT_TYPES.map((type) => (
          <Chip key={type} label={t(`map.slot.${type}`)} selected={selected === type} onPress={() => onSelect(type)} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
