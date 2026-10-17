import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { usePalette } from '@/theme/theme';

interface ScreenProps {
  children: ReactNode;
  /** Forms: keyboard-aware and scrollable so inputs/buttons stay reachable. */
  isForm?: boolean;
}

export function Screen({ children, isForm = false }: ScreenProps) {
  const p = usePalette();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: p.background }]}>
      {isForm ? (
        <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={[styles.body, styles.grow]}
          >
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <View style={styles.body}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  grow: { flexGrow: 1 },
  body: { flex: 1, padding: 24, gap: 16 },
});
