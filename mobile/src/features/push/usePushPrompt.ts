import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';

import { decideNotificationPrompt } from '@/features/push/permissionPolicy';
import { ensureAndroidChannel, readPermission, requestPermission, syncDevice } from '@/features/push/pushRuntime';
import { authStore } from '@/store/auth';

let hasAskedThisRun = false;

/**
 * Contextual notification prompt: when `isMoment` turns true (a booking just got confirmed) a
 * short explanation is shown first, and only "Allow" opens the OS dialog. Never at launch, at
 * most once per app run, and silent when the OS would not show a dialog anyway.
 */
export function useNotificationPrompt(isMoment: boolean): void {
  const { t } = useTranslation();
  useEffect(() => {
    if (!isMoment) return;
    let isCancelled = false;
    void readPermission().then((permission) => {
      if (isCancelled || decideNotificationPrompt({ permission, hasAskedThisRun, isMoment }) === 'skip') return;
      hasAskedThisRun = true;
      Alert.alert(t('push.promptTitle'), t('push.promptText'), [
        { text: t('push.notNow'), style: 'cancel' },
        {
          text: t('push.enable'),
          onPress: () => {
            void ensureAndroidChannel(t('permissions.notificationsTitle'))
              .then(requestPermission)
              .then((state) => {
                const { user } = authStore.getState();
                if (state === 'granted' && user) void syncDevice(String(user.id));
              });
          },
        },
      ]);
    });
    return () => {
      isCancelled = true;
    };
  }, [isMoment, t]);
}
