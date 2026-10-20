import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TextInput } from 'react-native';

import { BackHeader } from '@/components/BackHeader';
import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { Screen } from '@/components/Screen';
import { profileSchema, type ProfileForm } from '@/features/auth/schemas';
import { profileApi } from '@/features/profile/profileService';
import { errorMessageKey, parseApiError } from '@/lib/errors';
import { authStore, useAuthStore } from '@/store/auth';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

/** settings/name: change the display name. */
export function NameScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const current = useAuthStore((s) => s.user?.first_name ?? '');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProfileForm>({ resolver: zodResolver(profileSchema), defaultValues: { firstName: current } });

  const onSubmit = async ({ firstName }: ProfileForm): Promise<void> => {
    setErrorKey(null);
    try {
      const epoch = authStore.getState().getEpoch(); // a response after logout / account switch is ignored
      const user = await profileApi.updateName(firstName);
      await authStore.getState().setUser(user, epoch);
      router.back();
    } catch (error: unknown) {
      setErrorKey(errorMessageKey(parseApiError(error)));
    }
  };

  return (
    <Screen isForm>
      <BackHeader title={t('profile.editName')} />
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
            style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface }]}
          />
        )}
      />
      <ErrorText message={errors.firstName?.message ? t(errors.firstName.message) : null} />
      <ErrorText message={errorKey ? t(errorKey) : null} />
      <Button label={t('profile.save')} loading={isSubmitting} onPress={() => void handleSubmit(onSubmit)()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 16 },
});
