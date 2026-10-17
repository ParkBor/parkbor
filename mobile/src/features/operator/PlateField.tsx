import { StyleSheet, Text, TextInput, View } from 'react-native';

import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface PlateFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: string | null;
  editable?: boolean;
}

/** Plate input: upper case, no autocorrect, no autofill (a plate is typed from the car). */
export function PlateField({ label, value, onChange, error = null, hint = null, editable = true }: PlateFieldProps) {
  const p = usePalette();
  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: p.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={editable}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        spellCheck={false}
        maxLength={16}
        placeholder="01 A 123 BC"
        placeholderTextColor={p.textMuted}
        style={[styles.input, { color: p.text, borderColor: error ? p.error : p.border, backgroundColor: p.surface }]}
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: p.error }}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={{ color: p.textMuted }}>{hint}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  label: { fontSize: 15, fontWeight: '600' },
  input: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 20, letterSpacing: 1 },
});
