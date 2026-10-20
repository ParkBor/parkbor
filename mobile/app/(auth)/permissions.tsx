import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { syncDevice } from '@/features/push/pushRuntime';
import { authStore } from '@/store/auth';
import { locationPrompt } from '@/features/map/locationPrompt';
import { useOnboardingStore } from '@/store/onboarding';
import { usePalette } from '@/theme/theme';

const NOTIFICATION_CHANNEL_ID = 'default';

type PermissionState = 'unknown' | 'granted' | 'denied';

interface RowProps {
  testID: string;
  title: string;
  text: string;
  state: PermissionState;
  onAllow: () => void;
}

function PermissionRow({ testID, title, text, state, onAllow }: RowProps) {
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
      {state === 'unknown' && <Button testID={testID} label={t('permissions.allow')} onPress={onAllow} />}
    </View>
  );
}

export default function PermissionsScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const [location, setLocation] = useState<PermissionState>('unknown');
  const [notifications, setNotifications] = useState<PermissionState>('unknown');

  const askLocation = async () => {
    try {
      const res = await Location.requestForegroundPermissionsAsync();
      setLocation(res.granted ? 'granted' : 'denied');
    } catch {
      setLocation('denied'); // the native call failed: show the settings route instead of crashing
    }
  };
  const askNotificationsUnsafe = async () => {
    // Android 13+ only shows the permission prompt once a channel exists.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
        name: t('permissions.notificationsTitle'),
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const res = await Notifications.requestPermissionsAsync();
    setNotifications(res.granted ? 'granted' : 'denied');
    // Allowed right now: register this phone for push without waiting for the next app start.
    const { user } = authStore.getState();
    if (res.granted && user) void syncDevice(String(user.id));
  };
  const askNotifications = async () => {
    try {
      await askNotificationsUnsafe();
    } catch {
      setNotifications('denied'); // the native call failed: offer the settings route instead of crashing
    }
  };
  // Clearing the step lets the auth guard route to (tabs).
  const finish = () => useOnboardingStore.getState().setStep(null);
  // "Later": leave without asking; the map does not show the location dialog until the user opens a location action.
  const later = () => {
    locationPrompt.defer();
    finish();
  };

  return (
    <Screen isScrollable>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('permissions.title')}
      </Text>
      <Text style={{ color: p.textMuted }}>{t('permissions.subtitle')}</Text>
      <PermissionRow
        testID="permissions-allow-location"
        title={t('permissions.locationTitle')}
        text={t('permissions.locationText')}
        state={location}
        onAllow={() => void askLocation()}
      />
      <PermissionRow
        testID="permissions-allow-notifications"
        title={t('permissions.notificationsTitle')}
        text={t('permissions.notificationsText')}
        state={notifications}
        onAllow={() => void askNotifications()}
      />
      <View style={styles.spacer} />
      <Button label={t('permissions.finish')} onPress={finish} />
      <Button variant="secondary" label={t('permissions.later')} onPress={later} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 26, fontWeight: '700' },
  row: { padding: 16, borderRadius: 12, gap: 8 },
  rowTitle: { fontSize: 17, fontWeight: '600' },
  spacer: { flex: 1 },
});
