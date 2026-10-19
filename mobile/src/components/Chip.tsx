import { Pressable, StyleSheet, Text } from 'react-native';

import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface ChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  /** 'radio' for single choice groups, 'checkbox' for toggles. */
  role?: 'radio' | 'checkbox';
  disabled?: boolean;
  /** Stable handle for UI tests. */
  testID?: string;
}

/** Selectable pill; selection is conveyed by fill AND by accessibility state, not by color only. */
export function Chip({ label, selected, onPress, role = 'radio', disabled = false, testID }: ChipProps) {
  const p = usePalette();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={{ selected, checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.base,
        {
          opacity: disabled ? 0.5 : 1,
          backgroundColor: selected ? p.primary : p.surface,
          borderColor: selected ? p.primary : p.border,
        },
      ]}
    >
      <Text style={[styles.label, { color: selected ? p.onPrimary : p.text }]}>
        {selected ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: MIN_TOUCH,
    minWidth: MIN_TOUCH,
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 15, fontWeight: '600' },
});
