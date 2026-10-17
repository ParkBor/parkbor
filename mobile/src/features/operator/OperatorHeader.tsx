import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface OperatorHeaderProps {
  title: string;
  subtitle?: string | null;
  /** Replaces the default back action (e.g. a confirmation while cash is pending). */
  onBack?: () => void;
}

/** Back button + title for the full-screen operator routes (the root stack has no native header). */
export function OperatorHeader({ title, subtitle, onBack }: OperatorHeaderProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
        onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/(tabs)')))}
        style={styles.back}
      >
        <Text style={[styles.backGlyph, { color: p.primary }]}>‹</Text>
      </Pressable>
      <View style={styles.titles}>
        <Text accessibilityRole="header" style={[styles.title, { color: p.text }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: p.textMuted }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  back: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  backGlyph: { fontSize: 36, lineHeight: 40 },
  titles: { flex: 1 },
  title: { fontSize: 20, fontWeight: '700' },
});
