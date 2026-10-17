import type { Ref } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CODE_LENGTH, toCells } from '@/features/auth/code';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface CodeCellsProps {
  value: string;
  onChangeText: (text: string) => void;
  isEditable: boolean;
  accessibilityLabel: string;
  accessibilityHint: string;
  inputRef: Ref<TextInput>;
}

/**
 * Six visual cells over ONE real text input. Only the input is exposed to screen readers
 * (the cells are decorative), so TalkBack/VoiceOver see a single focus target.
 */
export function CodeCells({
  value,
  onChangeText,
  isEditable,
  accessibilityLabel,
  accessibilityHint,
  inputRef,
}: CodeCellsProps) {
  const p = usePalette();
  const focusInput = () => {
    if (inputRef && typeof inputRef === 'object') inputRef.current?.focus();
  };

  return (
    <Pressable accessible={false} onPress={focusInput} style={styles.cells}>
      {toCells(value).map((digit, i) => (
        <View
          key={i}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          style={[
            styles.cell,
            { borderColor: i === value.length ? p.primary : p.border, backgroundColor: p.surface },
          ]}
        >
          <Text style={[styles.digit, { color: p.text }]}>{digit}</Text>
        </View>
      ))}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        editable={isEditable}
        keyboardType="number-pad"
        maxLength={CODE_LENGTH}
        autoFocus
        caretHidden
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        style={styles.hiddenInput}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cells: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginVertical: 8 },
  cell: {
    flex: 1,
    minHeight: MIN_TOUCH + 8,
    borderWidth: 2,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  digit: { fontSize: 24, fontWeight: '700' },
  hiddenInput: { position: 'absolute', width: '100%', height: '100%', opacity: 0.02 },
});
