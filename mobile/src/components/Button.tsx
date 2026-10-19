import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'telegram' | 'secondary';
  disabled?: boolean;
  loading?: boolean;
  /** Stable handle for UI tests (Android resource-id / iOS accessibilityIdentifier). */
  testID?: string;
}

export function Button({ label, onPress, variant = 'primary', disabled = false, loading = false, testID }: ButtonProps) {
  const p = usePalette();
  const inactive = disabled || loading;
  const background =
    variant === 'telegram' ? p.telegram : variant === 'primary' ? p.primary : 'transparent';
  const color =
    variant === 'telegram' ? p.onTelegram : variant === 'primary' ? p.onPrimary : p.primary;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={[
        styles.base,
        { backgroundColor: background, borderColor: p.primary, opacity: inactive ? 0.5 : 1 },
        variant === 'secondary' && styles.outlined,
      ]}
    >
      {loading ? <ActivityIndicator color={color} /> : <Text style={[styles.label, { color }]}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH,
    borderRadius: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlined: { borderWidth: 1 },
  label: { fontSize: 16, fontWeight: '600' },
});
