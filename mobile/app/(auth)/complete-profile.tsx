import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TextInput } from 'react-native';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { Screen } from '@/components/Screen';
import { VehicleFields } from '@/features/vehicles/VehicleFields';
import { classifyVehicleError } from '@/features/vehicles/vehicleErrors';
import { validateVehicleForm, type VehicleType } from '@/features/vehicles/schemas';
import { vehiclesApi } from '@/features/vehicles/vehiclesApi';
import { profileSchema, type ProfileForm } from '@/features/auth/schemas';
import { api } from '@/lib/api';
import { errorMessageKey, parseApiError } from '@/lib/errors';
import type { User } from '@/lib/types';
import { authStore } from '@/store/auth';
import { useOnboardingStore } from '@/store/onboarding';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

export default function CompleteProfileScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Optional first vehicle: an empty plate means "skip".
  const [plate, setPlate] = useState('');
  const [vehicleType, setVehicleType] = useState<VehicleType>('CAR');
  const [plateError, setPlateError] = useState<string | undefined>(undefined);
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProfileForm>({ resolver: zodResolver(profileSchema), defaultValues: { firstName: '' } });

  // The name is saved first (PATCH /me), then the optional first vehicle (POST /vehicles).
  const onSubmit = async ({ firstName }: ProfileForm) => {
    setSubmitError(null);
    setPlateError(undefined);
    const wantsVehicle = plate.trim().length > 0;
    const vehicle = wantsVehicle ? validateVehicleForm({ plate, type: vehicleType }) : null;
    if (vehicle && !vehicle.ok) {
      setPlateError(vehicle.errors.plate);
      return;
    }
    try {
      // Epoch at the START: a response arriving after logout / another account is ignored.
      const startedEpoch = authStore.getState().getEpoch();
      const res = await api.patch<User>('/me', { first_name: firstName });
      await authStore.getState().setUser(res.data, startedEpoch);
      if (vehicle?.ok && authStore.getState().getEpoch() === startedEpoch) {
        try {
          await vehiclesApi.create(vehicle.value);
        } catch (error: unknown) {
          // Stay here: fix the plate or clear the field to skip. The name is already saved.
          setSubmitError(classifyVehicleError(error).key);
          return;
        }
      }
      if (authStore.getState().getEpoch() === startedEpoch) {
        useOnboardingStore.getState().setStep('permissions');
      }
    } catch (error: unknown) {
      setSubmitError(errorMessageKey(parseApiError(error)));
    }
  };

  const fieldError = errors.firstName?.message;

  return (
    <Screen isForm>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('profile.title')}
      </Text>
      <Text style={{ color: p.textMuted }}>{t('profile.subtitle')}</Text>
      <Text style={{ color: p.text }}>{t('profile.firstName')}</Text>
      <Controller
        control={control}
        name="firstName"
        render={({ field: { value, onChange, onBlur } }) => (
          <TextInput
            testID="profile-first-name"
            value={value}
            onChangeText={onChange}
            onBlur={onBlur}
            placeholder={t('profile.firstNamePlaceholder')}
            placeholderTextColor={p.textMuted}
            accessibilityLabel={t('profile.firstName')}
            autoCapitalize="words"
            autoComplete="given-name"
            textContentType="givenName"
            maxLength={150}
            style={[styles.input, { color: p.text, borderColor: fieldError ? p.error : p.border, backgroundColor: p.surface }]}
          />
        )}
      />
      <ErrorText message={fieldError ? t(fieldError) : null} />
      <Text style={[styles.section, { color: p.text }]}>{t('vehicles.firstTitle')}</Text>
      <Text style={{ color: p.textMuted }}>{t('vehicles.firstText')}</Text>
      <VehicleFields
        plate={plate}
        type={vehicleType}
        plateError={plateError}
        onPlateChange={setPlate}
        onTypeChange={setVehicleType}
      />
      <ErrorText message={submitError ? t(submitError) : null} />
      <Button
        label={isSubmitting ? t('profile.saving') : t('profile.save')}
        loading={isSubmitting}
        onPress={() => void handleSubmit(onSubmit)()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 26, fontWeight: '700' },
  section: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  input: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
});
