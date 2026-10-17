import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { authStore } from '@/store/auth';
import { usePalette } from '@/theme/theme';

/** Shown when a stored session exists but the server could not be reached to verify it. */
export default function OfflineScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <Screen>
      <View style={styles.body}>
        <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
          {t('offline.title')}
        </Text>
        <Text style={[styles.text, { color: p.textMuted }]}>{t('offline.text')}</Text>
      </View>
      <Button label={t('offline.retry')} onPress={() => void authStore.getState().bootstrap()} />
      <Button
        variant="secondary"
        label={t('offline.signIn')}
        onPress={() => authStore.getState().leaveOffline()}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, justifyContent: 'center', gap: 12 },
  title: { fontSize: 26, fontWeight: '700' },
  text: { fontSize: 16, lineHeight: 23 },
});
