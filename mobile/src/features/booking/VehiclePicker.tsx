import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { ErrorText } from '@/components/ErrorText';
import type { Vehicle } from '@/features/vehicles/schemas';
import { formatPlate } from '@/features/vehicles/vehiclePlate';
import { usePalette } from '@/theme/theme';

interface VehiclePickerProps {
  vehicles: readonly Vehicle[];
  isLoading: boolean;
  selectedId: string | null;
  /** The chosen vehicle does not suit the chosen spot type (checked before the server says so). */
  hasMismatch: boolean;
  onSelect: (vehicle: Vehicle) => void;
  onUseMatching: () => void;
  onAdd: () => void;
}

export function VehiclePicker({ vehicles, isLoading, selectedId, hasMismatch, onSelect, onUseMatching, onAdd }: VehiclePickerProps) {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <View style={styles.root}>
      <Text style={{ color: p.text }}>{t('booking.form.vehicle')}</Text>
      {vehicles.length === 0 && !isLoading ? (
        <>
          <Text style={{ color: p.textMuted }}>{t('booking.form.noVehicle')}</Text>
          <Button variant="secondary" label={t('booking.form.addVehicle')} onPress={onAdd} />
        </>
      ) : (
        <View style={styles.chips} accessibilityRole="radiogroup">
          {vehicles.map((vehicle) => (
            <Chip
              key={vehicle.id}
              label={formatPlate(vehicle.plateNumber)}
              selected={vehicle.id === selectedId}
              onPress={() => onSelect(vehicle)}
            />
          ))}
        </View>
      )}
      {selectedId === null && vehicles.length > 0 ? <Text style={{ color: p.textMuted }}>{t('booking.form.pickVehicle')}</Text> : null}
      {hasMismatch ? (
        <>
          <ErrorText message={t('booking.form.mismatch')} />
          <Button variant="secondary" label={t('booking.form.useMatching')} onPress={onUseMatching} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
