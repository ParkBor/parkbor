import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useOnboardingStore } from '@/store/onboarding';
import { usePalette } from '@/theme/theme';

const NOTIFICATION_CHANNEL_ID = 'default';

type PermissionState = 'unknown' | 'granted' | 'denied';

interface RowProps {
  title: string;
  text: string;
  state: PermissionState;
  onAllow: () => void;
}

function PermissionRow({ title, text, state, onAllow }: RowProps) {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <View style={[styles.row, { backgroundColor: p.surface }]}>
      <Text style={[styles.rowTitle, { color: p.text }]}>{title}</Text>
      <Text style={{ color: p.textMuted }}>{text}</Text>
      {state === 'granted' && <Text style={{ color: p.successText }}>{t('permissions.granted')}</Text>}
      {state === 'denied' && (
        <>
          <Text style={{ color: p.warningText }}>{t('permissions.denied')}</Text>
          <Button variant="secondary" label={t('permissions.openSettings')} onPress={() => void Linking.openSettings()} />
        </>
      )}
      {state === 'unknown' && <Button label={t('permissions.allow')} onPress={onAllow} />}
    </View>
  );
}

export default function PermissionsScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const [location, setLocation] = useState<PermissionState>('unknown');
  const [notifications, setNotifications] = useState<PermissionState>('unknown');

  const askLocation = async () => {
    const res = await Location.requestForegroundPermissionsAsync();
    setLocation(res.granted ? 'granted' : 'denied');
  };
  const askNotifications = async () => {
    // Android 13+ only shows the permission prompt once a channel exists.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
        name: t('permissions.notificationsTitle'),
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const res = await Notifications.requestPermissionsAsync();
    setNotifications(res.granted ? 'granted' : 'denied');
  };
  // Clearing the step lets the auth guard route to (tabs).
  const finish = () => useOnboardingStore.getState().setStep(null);

  return (
    <Screen>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('permissions.title')}
      </Text>
      <Text style={{ color: p.textMuted }}>{t('permissions.subtitle')}</Text>
      <PermissionRow
        title={t('permissions.locationTitle')}
        text={t('permissions.locationText')}
        state={location}
        onAllow={() => void askLocation()}
      />
      <PermissionRow
        title={t('permissions.notificationsTitle')}
        text={t('permissions.notificationsText')}
        state={notifications}
        onAllow={() => void askNotifications()}
      />
      <View style={styles.spacer} />
      <Button label={t('permissions.finish')} onPress={finish} />
      <Button variant="secondary" label={t('permissions.later')} onPress={finish} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 26, fontWeight: '700' },
  row: { padding: 16, borderRadius: 12, gap: 8 },
  rowTitle: { fontSize: 17, fontWeight: '600' },
  spacer: { flex: 1 },
});
