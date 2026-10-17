import { StyleSheet, Text } from 'react-native';

import { usePalette } from '@/theme/theme';

export function ErrorText({ message }: { message: string | null | undefined }) {
  const p = usePalette();
  if (!message) return null;
  return (
    <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.text, { color: p.error }]}>
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({ text: { fontSize: 14, textAlign: 'center' } });
