import { zodResolver } from '@hookform/resolvers/zod';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { Screen } from '@/components/Screen';
import { classifyVehicleError } from '@/features/vehicles/vehicleErrors';
import {
  validateVehicleForm,
  vehicleFormSchema,
  type VehicleFormValues,
} from '@/features/vehicles/schemas';
import { VehicleFields } from '@/features/vehicles/VehicleFields';
import { useSaveVehicle, useVehicles } from '@/features/vehicles/useVehicles';
import { firstParam } from '@/features/route/lotParams';
import { isUuid } from '@/lib/contract';
import { usePalette } from '@/theme/theme';

const NEW_VEHICLE: VehicleFormValues = { plate: '', type: 'CAR' };

/** vehicles/edit: create (no `id`) or edit (`id` = vehicle UUID). The plate is normalised before it is sent. */
export function VehicleEditScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const rawId = firstParam(params.id);
  const editingId = isUuid(rawId) ? rawId : null;
  const vehicles = useVehicles();
  const existing = editingId ? vehicles.data?.find((vehicle) => vehicle.id === editingId) : undefined;
  const save = useSaveVehicle();
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<VehicleFormValues>({
    resolver: zodResolver(vehicleFormSchema),
    defaultValues: NEW_VEHICLE,
    // keepDirtyValues: what the user already typed is never overwritten when the vehicle arrives.
    ...(existing ? { values: { plate: existing.plateNumber, type: existing.type }, resetOptions: { keepDirtyValues: true } } : {}),
  });

  // Editing: wait for the vehicle to load, and refuse to PUT one that is not in the list (404).
  const isLoadingExisting = editingId !== null && vehicles.isPending;
  const isMissing = editingId !== null && !vehicles.isPending && existing === undefined;

  const onSubmit = async (form: VehicleFormValues): Promise<void> => {
    if (isLoadingExisting || isMissing) return;
    setSubmitError(null);
    const checked = validateVehicleForm(form);
    if (!checked.ok) return;
    try {
      await save.mutateAsync({ id: editingId, values: checked.value });
      if (router.canGoBack()) router.back();
      else router.replace('/vehicles');
    } catch (error: unknown) {
      setSubmitError(classifyVehicleError(error).key);
    }
  };

  return (
    <Screen isForm>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {editingId ? t('vehicles.editTitle') : t('vehicles.addTitle')}
      </Text>
      <Controller
        control={control}
        name="plate"
        render={({ field: plate }) => (
          <Controller
            control={control}
            name="type"
            render={({ field: type }) => (
              <VehicleFields
                plate={plate.value}
                type={type.value}
                plateError={errors.plate?.message}
                typeError={errors.type?.message}
                onPlateChange={plate.onChange}
                onPlateBlur={plate.onBlur}
                onTypeChange={type.onChange}
              />
            )}
          />
        )}
      />
      <ErrorText message={submitError ? t(submitError) : null} />
      {isMissing ? <ErrorText message={t('failure.notFound')} /> : null}
      <Button
        label={save.isPending ? t('vehicles.saving') : t('vehicles.save')}
        loading={save.isPending || isLoadingExisting}
        disabled={isMissing}
        onPress={() => void handleSubmit(onSubmit)()}
      />
      <Button variant="secondary" label={t('vehicles.cancel')} onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({ title: { fontSize: 24, fontWeight: '700' } });
