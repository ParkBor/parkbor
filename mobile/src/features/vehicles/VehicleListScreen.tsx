import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { Screen } from '@/components/Screen';
import { classifyVehicleError } from '@/features/vehicles/vehicleErrors';
import { formatPlate } from '@/features/vehicles/vehiclePlate';
import type { Vehicle } from '@/features/vehicles/schemas';
import { useRemoveVehicle, useVehicles } from '@/features/vehicles/useVehicles';
import { usePalette } from '@/theme/theme';

/** vehicles/index: the driver's vehicles with add / edit / delete. */
export function VehicleListScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const vehicles = useVehicles();
  const remove = useRemoveVehicle();
  const [actionError, setActionError] = useState<string | null>(null);

  const edit = (vehicle: Vehicle): void => router.push({ pathname: '/vehicles/edit', params: { id: vehicle.id } });

  const confirmRemove = (vehicle: Vehicle): void => {
    Alert.alert(t('vehicles.removeTitle'), t('vehicles.removeText'), [
      { text: t('vehicles.cancel'), style: 'cancel' },
      {
        text: t('vehicles.removeConfirm'),
        style: 'destructive',
        onPress: () => {
          setActionError(null);
          remove.mutate(vehicle.id, { onError: (error: unknown) => setActionError(classifyVehicleError(error).key) });
        },
      },
    ]);
  };

  const loadErrorKey = vehicles.isError ? classifyVehicleError(vehicles.error).key : null;
  const items = vehicles.data ?? [];

  return (
    <Screen>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('vehicles.title')}
      </Text>
      <ErrorText message={actionError ? t(actionError) : null} />
      {loadErrorKey && items.length === 0 ? (
        <View style={styles.center}>
          <ErrorText message={t(loadErrorKey)} />
          <Button variant="secondary" label={t('common.retry')} onPress={() => void vehicles.refetch()} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(vehicle) => vehicle.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={vehicles.isRefetching} onRefresh={() => void vehicles.refetch()} />}
          ListEmptyComponent={
            vehicles.isPending ? (
              <Text style={{ color: p.textMuted }}>{t('common.loading')}</Text>
            ) : (
              <View style={styles.center}>
                <Text style={[styles.emptyTitle, { color: p.text }]}>{t('vehicles.empty')}</Text>
                <Text style={{ color: p.textMuted }}>{t('vehicles.emptyText')}</Text>
              </View>
            )
          }
          renderItem={({ item }) => (
            <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
              <View style={styles.cardText}>
                <Text style={[styles.plate, { color: p.text }]}>{formatPlate(item.plateNumber)}</Text>
                <Text style={{ color: p.textMuted }}>{t(`vehicles.type_${item.type}`)}</Text>
              </View>
              <View style={styles.cardActions}>
                <Button variant="secondary" label={t('vehicles.edit')} onPress={() => edit(item)} />
                <Button
                  variant="secondary"
                  label={t('vehicles.remove')}
                  disabled={remove.isPending}
                  onPress={() => confirmRemove(item)}
                />
              </View>
            </View>
          )}
        />
      )}
      <Button label={t('vehicles.add')} onPress={() => router.push('/vehicles/edit')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 24, fontWeight: '700' },
  list: { gap: 12, flexGrow: 1 },
  center: { gap: 8, alignItems: 'center', paddingVertical: 24 },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 12 },
  cardText: { gap: 2 },
  plate: { fontSize: 20, fontWeight: '700', letterSpacing: 1 },
  cardActions: { flexDirection: 'row', gap: 8 },
});
