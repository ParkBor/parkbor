import { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, BackHandler } from 'react-native';

interface ExitConfirmOptions {
  isFocused: boolean;
  /** Offer "cancel the booking" only when the booking is known (the cancel dialog needs it). */
  canCancelBooking: boolean;
  onLeave: () => void;
  onCancelBooking: () => void;
}

/**
 * "Leave the payment?" confirmation, shared by the on-screen buttons and the Android back button
 * (which can never leave a payment in progress by accident). One dialog at a time: repeated presses
 * do not stack alerts.
 */
export function useExitConfirm({ isFocused, canCancelBooking, onLeave, onCancelBooking }: ExitConfirmOptions): () => void {
  const { t } = useTranslation();
  const isOpen = useRef(false);

  const confirmExit = useCallback((): void => {
    if (isOpen.current) return;
    isOpen.current = true;
    const close = (action?: () => void) => () => {
      isOpen.current = false;
      action?.();
    };
    Alert.alert(
      t('payment.webview.exitTitle'),
      t('payment.webview.exitBody'),
      [
        { text: t('payment.webview.exitStay'), style: 'cancel', onPress: close() },
        { text: t('payment.webview.exitLeave'), onPress: close(onLeave) },
        ...(canCancelBooking
          ? [{ text: t('payment.webview.exitCancelBooking'), style: 'destructive' as const, onPress: close(onCancelBooking) }]
          : []),
      ],
      { cancelable: true, onDismiss: close() },
    );
  }, [t, canCancelBooking, onLeave, onCancelBooking]);

  const onBackPress = useEffectEvent((): boolean => {
    confirmExit();
    return true;
  });
  useEffect(() => {
    if (!isFocused) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, [isFocused]);

  return confirmExit;
}
