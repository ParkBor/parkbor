import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { usePalette } from '@/theme/theme';
import { useScreenLayout } from '@/theme/useScreenLayout';

interface ScreenProps {
  children: ReactNode;
  /** Forms: keyboard-aware and scrollable so inputs/buttons stay reachable. */
  isForm?: boolean;
  /**
   * Short static screens (login, permissions, settings): scroll when the content does not fit (small
   * phones, large fonts, landscape). Not for screens that own a list or a camera - those scroll themselves.
   */
  isScrollable?: boolean;
}

/**
 * Safe-area aware screen: padding from the layout (smaller gutters on small phones) and a content
 * column capped at 560 dp and centred on tablets / landscape.
 */
export function Screen({ children, isForm = false, isScrollable = false }: ScreenProps) {
  const p = usePalette();
  const { column, gutter } = useScreenLayout();
  const padded = [styles.body, { padding: gutter }, column];
  const content =
    isForm || isScrollable ? (
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[...padded, styles.grow]}>
        {children}
      </ScrollView>
    ) : (
      <View style={[...padded, styles.fill]}>{children}</View>
    );
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: p.background }]}>
      {isForm ? (
        <KeyboardAvoidingView style={styles.root} // Android is edge-to-edge (SDK 57): the window is no longer resized for the keyboard, so 'height' does it here.
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          {content}
        </KeyboardAvoidingView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // scroll content must be able to grow beyond the viewport: flexGrow, never flex: 1
  grow: { flexGrow: 1 },
  fill: { flex: 1 },
  body: { gap: 16 },
});
