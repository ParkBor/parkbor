import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/Icon';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface BackHeaderProps {
  title?: string;
  /** Defaults to "go back, or to the tabs when there is nothing to go back to" (deep links). */
  onBack?: () => void;
}

/** Stack screens have no native header (headerShown: false): this is their visible way back. */
export function BackHeader({ title, onBack }: BackHeaderProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const goBack = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/(tabs)')));
  return (
    <View style={styles.row}>
      <Pressable
        testID="back-button"
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
        onPress={goBack}
        hitSlop={8}
        style={styles.button}
      >
        <Icon name="chevron-back" color={p.text} />
      </Pressable>
      {title ? (
        <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
          {title}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: MIN_TOUCH, marginLeft: -8 },
  button: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 22, fontWeight: '700' },
});
