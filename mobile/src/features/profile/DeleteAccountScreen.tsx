import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, Text } from 'react-native';

import { BackHeader } from '@/components/BackHeader';
import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { Screen } from '@/components/Screen';
import { profileApi } from '@/features/profile/profileService';
import { errorMessageKey, parseApiError } from '@/lib/errors';
import { authStore } from '@/store/auth';
import { usePalette } from '@/theme/theme';

/**
 * settings/delete-account: explains what is lost, asks twice, calls DELETE /me and only after the server
 * confirmed (204) wipes the session and every local copy. 409 account_deletion_blocked (active bookings or
 * owned parking lots) keeps everything and says why.
 */
export function DeleteAccountScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const [isBusy, setIsBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const remove = async (): Promise<void> => {
    setIsBusy(true);
    setErrorKey(null);
    try {
      await profileApi.deleteAccount();
      // The account is gone: no logout request (its tokens are dead). clearSession ends the session; the query cache,
      // offline QR copies, push registration and onboarding state are tied to it and cleared by their own bindings.
      await authStore.getState().clearSession();
    } catch (error: unknown) {
      setErrorKey(errorMessageKey(parseApiError(error)));
      setIsBusy(false);
    }
  };

  const confirm = (): void =>
    Alert.alert(t('profile.deleteConfirmTitle'), t('profile.deleteConfirmText'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('profile.deleteConfirmButton'), style: 'destructive', onPress: () => void remove() },
    ]);

  return (
    <Screen isScrollable>
      <BackHeader title={t('profile.deleteTitle')} />
      <Text style={[styles.text, { color: p.text }]}>{t('profile.deleteText')}</Text>
      <Text style={[styles.text, { color: p.textMuted }]}>{t('profile.deleteBlockedHint')}</Text>
      <ErrorText message={errorKey ? t(errorKey) : null} />
      <Button variant="danger" label={t('profile.deleteButton')} loading={isBusy} onPress={confirm} />
    </Screen>
  );
}

const styles = StyleSheet.create({ text: { fontSize: 16, lineHeight: 23 } });
