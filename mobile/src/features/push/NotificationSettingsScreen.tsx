import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, Linking, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { settingsAction, type PushPermission } from '@/features/push/permissionPolicy';
import { ensureAndroidChannel, readPermission, requestPermission, syncDevice } from '@/features/push/pushRuntime';
import { authStore } from '@/store/auth';
import { usePalette } from '@/theme/theme';

/** settings/notifications: shows the OS permission and the way to change it (also after a denial). */
export function NotificationSettingsScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const [permission, setPermission] = useState<PushPermission | null>(null);

  // Read now and whenever the app comes back (the user may have changed it in the OS settings).
  useEffect(() => {
    let isCurrent = true;
    const refresh = (): void => {
      void readPermission().then((next) => {
        if (isCurrent) setPermission(next);
      });
    };
    refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => {
      isCurrent = false;
      subscription.remove();
    };
  }, []);

  const action = permission ? settingsAction(permission) : 'none';

  const allow = async (): Promise<void> => {
    await ensureAndroidChannel(t('permissions.notificationsTitle'));
    const state = await requestPermission();
    setPermission(await readPermission());
    const { user } = authStore.getState();
    if (state === 'granted' && user) void syncDevice(String(user.id));
  };

  return (
    <Screen>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('push.settingsTitle')}
      </Text>
      <Text style={{ color: p.textMuted }}>{t('push.settingsHint')}</Text>
      {permission ? (
        <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
          <Text style={{ color: permission.state === 'granted' ? p.successText : p.warningText }}>
            {permission.state === 'granted' ? t('push.settingsOn') : t('push.settingsOff')}
          </Text>
        </View>
      ) : null}
      {action === 'request' ? <Button label={t('push.enable')} onPress={() => void allow()} /> : null}
      {action === 'open_settings' ? (
        <Button label={t('permissions.openSettings')} onPress={() => void Linking.openSettings()} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700' },
  card: { borderWidth: 1, borderRadius: 12, padding: 12 },
});
