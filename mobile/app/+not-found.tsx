import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { notFoundTarget } from '@/lib/notFound';
import { useAuthStore } from '@/store/auth';
import { useOnboardingStore } from '@/store/onboarding';
import { usePalette } from '@/theme/theme';

/**
 * Unknown route (also hostile links such as parkbor://evil). Shows nothing from the link; the button
 * leads to the safe landing for the current session state.
 */
export default function NotFoundScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const status = useAuthStore((s) => s.status);
  const onboarding = useOnboardingStore((s) => s.step);
  return (
    <Screen isScrollable>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('notFound.title')}
      </Text>
      <Text style={{ color: p.textMuted }}>{t('notFound.text')}</Text>
      <Button testID="not-found-back" label={t('notFound.back')} onPress={() => router.replace(notFoundTarget({ status, onboarding }))} />
    </Screen>
  );
}

const styles = StyleSheet.create({ title: { fontSize: 22, fontWeight: '700' } });
