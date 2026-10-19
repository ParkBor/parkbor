import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { authStore, useAuthStore } from '@/store/auth';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

// TODO(profile step): language, notifications, account deletion.
export default function ProfileTab() {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const firstName = useAuthStore((s) => s.user?.first_name ?? '');
  return (
    <Screen>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {firstName ? t('tabs.profileHello', { name: firstName }) : t('tabs.profile')}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('vehicles.title')}
        onPress={() => router.push('/vehicles')}
        style={[styles.row, { backgroundColor: p.surface, borderColor: p.border }]}
      >
        <Text style={[styles.rowTitle, { color: p.text }]}>{t('vehicles.title')}</Text>
        <Text style={{ color: p.textMuted }}>{t('vehicles.menuHint')}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('push.settingsTitle')}
        onPress={() => router.push('/settings/notifications')}
        style={[styles.row, { backgroundColor: p.surface, borderColor: p.border }]}
      >
        <Text style={[styles.rowTitle, { color: p.text }]}>{t('push.settingsTitle')}</Text>
        <Text style={{ color: p.textMuted }}>{t('push.settingsHint')}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('operator.join.link')}
        onPress={() => router.push('/operator/join')}
        style={[styles.row, { backgroundColor: p.surface, borderColor: p.border }]}
      >
        <Text style={[styles.rowTitle, { color: p.text }]}>{t('operator.join.link')}</Text>
        <Text style={{ color: p.textMuted }}>{t('operator.join.linkHint')}</Text>
      </Pressable>
      <Button testID="logout-button" variant="secondary" label={t('common.logout')} onPress={() => void authStore.getState().logout()} />
    </Screen>
  );
}



const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700' },
  row: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 12, padding: 12, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: '700' },
});
