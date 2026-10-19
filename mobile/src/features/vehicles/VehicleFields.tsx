import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip } from '@/components/Chip';
import { ErrorText } from '@/components/ErrorText';
import { normalizePlate } from '@/features/vehicles/vehiclePlate';
import { VEHICLE_TYPES, type VehicleType } from '@/features/vehicles/schemas';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface VehicleFieldsProps {
  plate: string;
  type: VehicleType;
  /** i18n keys of field errors. */
  plateError?: string | undefined;
  typeError?: string | undefined;
  onPlateChange: (plate: string) => void;
  onPlateBlur?: () => void;
  onTypeChange: (type: VehicleType) => void;
}

/** Plate input + vehicle type choice, shared by the edit screen and the first-vehicle step. */
export function VehicleFields({
  plate,
  type,
  plateError,
  typeError,
  onPlateChange,
  onPlateBlur,
  onTypeChange,
}: VehicleFieldsProps) {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <View style={styles.root}>
      <Text style={{ color: p.text }}>{t('vehicles.plate')}</Text>
      <TextInput
        testID="vehicle-plate-input"
        value={plate}
        onChangeText={onPlateChange}
        onBlur={() => {
          onPlateChange(normalizePlate(plate));
          onPlateBlur?.();
        }}
        placeholder={t('vehicles.platePlaceholder')}
        placeholderTextColor={p.textMuted}
        accessibilityLabel={t('vehicles.plate')}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        maxLength={32}
        style={[
          styles.input,
          { color: p.text, borderColor: plateError ? p.error : p.border, backgroundColor: p.surface },
        ]}
      />
      <Text style={[styles.hint, { color: p.textMuted }]}>{t('vehicles.plateHint')}</Text>
      <ErrorText message={plateError ? t(plateError) : null} />

      <Text style={{ color: p.text }}>{t('vehicles.type')}</Text>
      <View style={styles.chips} accessibilityRole="radiogroup">
        {VEHICLE_TYPES.map((option) => (
          <Chip
            key={option}
            label={t(`vehicles.type_${option}`)}
            selected={type === option}
            onPress={() => onTypeChange(option)}
          />
        ))}
      </View>
      <ErrorText message={typeError ? t(typeError) : null} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  input: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 18, letterSpacing: 1 },
  hint: { fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
