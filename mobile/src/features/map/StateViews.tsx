import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { usePalette } from '@/theme/theme';

const SKELETON_ROWS = 3;
const PULSE_MS = 800;

/** Placeholder rows shown while the first search is loading. */
export function ListSkeleton() {
  const { t } = useTranslation();
  const p = usePalette();
  const [opacity] = useState(() => new Animated.Value(0.4));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: PULSE_MS, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: PULSE_MS, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={t('map.loading')} style={styles.skeleton}>
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <Animated.View key={i} style={[styles.skeletonRow, { backgroundColor: p.surface, opacity }]}>
          <View style={[styles.bar, styles.barWide, { backgroundColor: p.border }]} />
          <View style={[styles.bar, styles.barNarrow, { backgroundColor: p.border }]} />
        </Animated.View>
      ))}
    </View>
  );
}

interface MessageProps {
  title?: string;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Errors are announced to screen readers. */
  isError?: boolean;
}

/** Empty / error block with an optional action. */
export function MessageView({ title, text, actionLabel, onAction, isError = false }: MessageProps) {
  const p = usePalette();
  return (
    <View style={styles.message} accessibilityRole={isError ? 'alert' : undefined} accessibilityLiveRegion="polite">
      {title ? <Text style={[styles.messageTitle, { color: p.text }]}>{title}</Text> : null}
      <Text style={[styles.messageText, { color: isError ? p.error : p.textMuted }]}>{text}</Text>
      {actionLabel && onAction ? <Button variant="secondary" label={actionLabel} onPress={onAction} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  skeleton: { gap: 12, paddingHorizontal: 16, paddingTop: 8 },
  skeletonRow: { borderRadius: 12, padding: 16, gap: 10, minHeight: 72 },
  bar: { height: 12, borderRadius: 6 },
  barWide: { width: '60%' },
  barNarrow: { width: '35%' },
  message: { gap: 12, padding: 24, alignItems: 'stretch' },
  messageTitle: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  messageText: { fontSize: 15, textAlign: 'center' },
});
