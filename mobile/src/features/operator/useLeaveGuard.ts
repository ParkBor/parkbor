import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, BackHandler } from 'react-native';

/**
 * While cash is pending, leaving the screen asks first (header back button AND the Android back
 * button). Returns the handler for the header; leaving drops the in-memory flow (the debt stays on
 * the server, and a repeated exit scan shows it again).
 */
export function useLeaveGuard(isEnabled: boolean): () => void {
  const { t } = useTranslation();
  const router = useRouter();

  const leave = useCallback((): void => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [router]);

  const confirm = useCallback((): void => {
    if (!isEnabled) {
      leave();
      return;
    }
    Alert.alert(t('operator.cash.leaveTitle'), t('operator.cash.leaveText'), [
      { text: t('operator.cash.stay'), style: 'cancel' },
      { text: t('operator.cash.leaveConfirm'), style: 'destructive', onPress: leave },
    ]);
  }, [isEnabled, leave, t]);

  useEffect(() => {
    if (!isEnabled) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      confirm();
      return true;
    });
    return () => subscription.remove();
  }, [isEnabled, confirm]);

  return confirm;
}
