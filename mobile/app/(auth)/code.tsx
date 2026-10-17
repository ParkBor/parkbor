import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, StyleSheet, Text, type TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { Screen } from '@/components/Screen';
import { CodeCells } from '@/features/auth/CodeCells';
import {
  clipboardHoldsCode,
  CODE_LENGTH,
  extractCode,
  formatTimer,
  sanitizeCode,
} from '@/features/auth/code';
import { MAX_CODE_ATTEMPTS } from '@/features/auth/createLoginStore';
import { loginStore, useLoginStore } from '@/features/auth/loginStore';
import { useCodeTimer } from '@/features/auth/useCodeTimer';
import { useAuthStore } from '@/store/auth';
import { usePalette } from '@/theme/theme';

export default function CodeScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const authStatus = useAuthStore((s) => s.status);
  const session = useLoginStore((s) => s.session);
  const endedReason = useLoginStore((s) => s.endedReason);
  const isConfirmed = useLoginStore((s) => s.isConfirmed);
  const isSubmitting = useLoginStore((s) => s.isSubmitting);
  const failedAttempts = useLoginStore((s) => s.failedAttempts);

  const [code, setCode] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const pastedCode = useRef<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  const secondsLeft = useCodeTimer(session?.expiresAt ?? null);
  const isEnded = endedReason !== null || (session !== null && secondsLeft === 0);
  const message = errorKey ?? endedReason;

  const goLogin = useCallback(() => {
    loginStore.getState().reset();
    router.replace('/(auth)/login');
  }, [router]);

  // No login in progress (e.g. cold start on this route) -> back to login. Never while a
  // sign-in is completing: the session stays set until the auth layer is done.
  useEffect(() => {
    if (!session && !endedReason && authStatus === 'anonymous') router.replace('/(auth)/login');
  }, [session, endedReason, authStatus, router]);

  /** Wipes the clipboard only if it still holds the code WE filled in from it. */
  const wipePastedCode = useCallback(async () => {
    const pasted = pastedCode.current;
    if (!pasted) return;
    pastedCode.current = null;
    const text = await Clipboard.getStringAsync().catch(() => '');
    if (clipboardHoldsCode(text, pasted)) await Clipboard.setStringAsync('').catch(() => undefined);
  }, []);

  const submit = useCallback(
    async (value: string) => {
      setErrorKey(null);
      const result = await loginStore.getState().submitCode(value);
      if (result.ok) {
        await wipePastedCode();
        return; // the auth guard moves the user on
      }
      setErrorKey(result.errorKey);
      if (result.fatal) {
        await wipePastedCode(); // a dead session's code has no further use either
      } else {
        if (result.errorKey === 'errors.invalidCode') setCode('');
        inputRef.current?.focus();
      }
    },
    [wipePastedCode],
  );

  // The session ended some other way (server EXPIRED, timer): same cleanup.
  useEffect(() => {
    if (endedReason) void wipePastedCode();
  }, [endedReason, wipePastedCode]);

  /** Typing (or pasting into the field) is the user's action: submit once complete. */
  const handleChange = (raw: string) => {
    const next = sanitizeCode(raw);
    setCode(next);
    if (next.length === CODE_LENGTH && !loginStore.getState().isSubmitting) void submit(next);
  };

  /** Fills the field from the clipboard; NEVER submits (the user reviews and confirms). */
  const fillFromClipboard = useCallback(async (isExplicit: boolean) => {
    const text = await Clipboard.getStringAsync().catch(() => '');
    const found = extractCode(text);
    if (found) {
      pastedCode.current = found;
      setCode(found);
      setErrorKey(null);
    } else if (isExplicit) {
      setErrorKey('code.pasteEmpty');
    }
  }, []);

  // Foreground: poll /status; only once the bot confirmed do we peek at the clipboard.
  useEffect(() => {
    const onActive = async () => {
      const result = await loginStore.getState().checkStatus();
      if (!result.ok) {
        // Surface network/429 instead of failing silently; the next foreground retries.
        setErrorKey(result.errorKey);
      } else if (result.value === 'CONFIRMED') {
        await fillFromClipboard(false);
      }
    };
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void onActive();
    });
    void loginStore.getState().checkStatus(); // initial state; no clipboard access here
    return () => sub.remove();
  }, [fillFromClipboard]);

  return (
    <Screen isForm>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('code.title')}
      </Text>
      <View style={[styles.warning, { borderColor: p.warningText, backgroundColor: p.surface }]}>
        <Text style={[styles.warningText, { color: p.text }]}>{t('code.phishingWarning')}</Text>
      </View>
      <Text style={{ color: p.textMuted }}>{t('code.subtitle')}</Text>
      <Text style={{ color: isConfirmed ? p.successText : p.textMuted }}>
        {isConfirmed ? t('code.confirmedHint') : t('code.pendingHint')}
      </Text>

      <CodeCells
        value={code}
        onChangeText={handleChange}
        isEditable={!isEnded && !isSubmitting}
        accessibilityLabel={t('code.inputLabel')}
        accessibilityHint={t('code.subtitle')}
        inputRef={inputRef}
      />

      <Text
        accessibilityLiveRegion={secondsLeft === 0 || secondsLeft % 60 === 0 ? 'polite' : 'none'}
        style={[styles.timer, { color: secondsLeft === 0 ? p.error : p.textMuted }]}
      >
        {isEnded ? t('code.timerExpired') : t('code.timerLabel', { time: formatTimer(secondsLeft) })}
      </Text>
      <ErrorText message={message ? t(message) : null} />
      {failedAttempts > 0 && !isEnded && (
        <Text style={{ color: p.warningText, textAlign: 'center' }}>
          {t('code.attemptsLeft', { count: MAX_CODE_ATTEMPTS - failedAttempts })}
        </Text>
      )}

      <View style={styles.spacer} />
      {isEnded ? (
        <Button label={t('code.startOver')} onPress={goLogin} />
      ) : (
        <>
          <Button
            label={isSubmitting ? t('code.verifying') : t('code.verify')}
            loading={isSubmitting}
            disabled={code.length !== CODE_LENGTH}
            onPress={() => void submit(code)}
          />
          <Button variant="secondary" label={t('code.pasteButton')} onPress={() => void fillFromClipboard(true)} />
          <Text style={[styles.hint, { color: p.textMuted }]}>{t('code.noCode')}</Text>
          <Button
            variant="secondary"
            label={t('code.reopenBot')}
            onPress={() =>
              void loginStore
                .getState()
                .reopenBot()
                .then((r) => setErrorKey(r.ok ? null : r.errorKey))
            }
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 26, fontWeight: '700' },
  warning: { borderWidth: 2, borderRadius: 12, padding: 12 },
  warningText: { fontSize: 15, fontWeight: '600', lineHeight: 21 },
  timer: { textAlign: 'center', fontSize: 15 },
  hint: { textAlign: 'center' },
  spacer: { flex: 1 },
});
