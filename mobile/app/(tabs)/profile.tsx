import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { LanguageRow } from '@/features/profile/LanguageRow';
import { authStore, useAuthStore } from '@/store/auth';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

export default function ProfileTab() {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const firstName = useAuthStore((s) => s.user?.first_name ?? '');

  const confirmLogout = (): void =>
    Alert.alert(t('profile.logoutTitle'), t('profile.logoutText'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.logout'), style: 'destructive', onPress: () => void authStore.getState().logout() },
    ]);

  return (
    <Screen isScrollable>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {firstName ? t('tabs.profileHello', { name: firstName }) : t('tabs.profile')}
      </Text>
      <Row title={t('profile.editName')} hint={firstName || t('profile.nameMissing')} onPress={() => router.push('/settings/name')} />
      <LanguageRow />
      <Row title={t('vehicles.title')} hint={t('vehicles.menuHint')} onPress={() => router.push('/vehicles')} />
      <Row title={t('push.settingsTitle')} hint={t('push.settingsHint')} onPress={() => router.push('/settings/notifications')} />
      <Row title={t('operator.join.link')} hint={t('operator.join.linkHint')} onPress={() => router.push('/operator/join')} />
      <Button testID="logout-button" variant="secondary" label={t('common.logout')} onPress={confirmLogout} />
      <Row title={t('profile.deleteTitle')} hint={t('profile.deleteHint')} onPress={() => router.push('/settings/delete-account')} isDanger />
    </Screen>
  );
}

interface RowProps {
  title: string;
  hint: string;
  onPress: () => void;
  isDanger?: boolean;
}

function Row({ title, hint, onPress, isDanger = false }: RowProps) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={[styles.row, { backgroundColor: p.surface, borderColor: p.border }]}
    >
      <Text style={[styles.rowTitle, { color: isDanger ? p.error : p.text }]}>{title}</Text>
      <Text style={{ color: p.textMuted }}>{hint}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700' },
  row: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 12, padding: 12, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: '700' },
});
