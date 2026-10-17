import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { ContractError } from '@/lib/contract';
import { classifyOperatorError } from '@/features/operator/gateErrors';
import { formatInviteCode, validateInviteCode } from '@/features/operator/inviteCode';
import { operatorApi } from '@/features/operator/operatorApi';
import { OperatorHeader } from '@/features/operator/OperatorHeader';
import { nextUserForRole } from '@/features/operator/tabVisibility';
import { useCountdownSeconds } from '@/features/operator/useCountdownSeconds';
import { api } from '@/lib/api';
import { authStore } from '@/store/auth';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

type Phase = { name: 'idle' } | { name: 'sending' } | { name: 'done'; lotName: string };

/**
 * Accept an owner's invite code. The code is typed by hand (never read from the clipboard by the
 * app), is not kept in any query/mutation cache, is never logged and is wiped on success. Every
 * refusal shows the same sentence (the server does not tell the reasons apart either).
 */
export function JoinScreen() {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [errorText, setErrorText] = useState<string | null>(null);
  const [waitSec, setWaitSec] = useState<number | null>(null);
  const [failureCount, setFailureCount] = useState(0);
  const waitLeft = useCountdownSeconds(waitSec, failureCount);
  // A second tap before the first answer must not send a second POST (it would come back as
  // invite_invalid and undo the success screen).
  const isSending = useRef(false);

  async function refreshRole(): Promise<void> {
    const epoch = authStore.getState().getEpoch();
    const response = await api.get<unknown>('/me');
    const next = nextUserForRole(authStore.getState().user, response.data);
    if (next) await authStore.getState().setUser(next, epoch);
    await queryClient.invalidateQueries({ queryKey: ['operator'] });
  }

  async function submit(): Promise<void> {
    if (isSending.current) return;
    const checked = validateInviteCode(code);
    if (!checked.ok) {
      setErrorText(t(`operator.join.${checked.reason}`));
      return;
    }
    setErrorText(null);
    setWaitSec(null);
    isSending.current = true;
    setPhase({ name: 'sending' });
    try {
      const accepted = await operatorApi.acceptInvite(checked.code);
      setCode('');
      setPhase({ name: 'done', lotName: accepted.lotName });
      // The role changed on the server: re-read /me so the Operator tab appears. A failure here is
      // harmless - the next foreground refresh (useRoleRefresh) picks the role up.
      await refreshRole().catch(() => undefined);
    } catch (error: unknown) {
      if (error instanceof ContractError) {
        // The server answered 2xx but the body is unreadable: the invite may well have been taken.
        // Re-read /me (the role may have changed) and tell the operator to check, instead of "refused".
        setCode('');
        await refreshRole().catch(() => undefined);
      }
      const failure = classifyOperatorError(error);
      setFailureCount((value) => value + 1);
      setErrorText(t(failure.reasonKey));
      setWaitSec(failure.retry === 'wait' ? failure.retryAfterSec : null);
      setPhase({ name: 'idle' });
    } finally {
      isSending.current = false;
    }
  }

  if (phase.name === 'done') {
    return (
      <Screen>
        <OperatorHeader title={t('operator.join.title')} />
        <View style={[styles.card, { borderColor: p.success, backgroundColor: p.surface }]}>
          <Text accessibilityLiveRegion="polite" style={[styles.ok, { color: p.successText }]}>
            ✓ {t('operator.join.successTitle')}
          </Text>
          <Text style={{ color: p.text, fontSize: 16 }}>{t('operator.join.successText', { lot: phase.lotName })}</Text>
        </View>
        <Button label={t('operator.join.open')} onPress={() => router.replace('/operator')} />
      </Screen>
    );
  }

  const isWaiting = waitLeft > 0;
  return (
    <Screen isForm>
      <OperatorHeader title={t('operator.join.title')} />
      <Text style={{ color: p.textMuted, fontSize: 16 }}>{t('operator.join.intro')}</Text>
      <Text style={{ color: p.text, fontWeight: '600' }}>{t('operator.join.codeLabel')}</Text>
      <TextInput
        accessibilityLabel={t('operator.join.codeLabel')}
        value={code}
        onChangeText={(value) => {
          setCode(formatInviteCode(value));
          setErrorText(null);
        }}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
        spellCheck={false}
        textContentType="none"
        keyboardType="visible-password"
        maxLength={40}
        placeholder="ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z"
        placeholderTextColor={p.textMuted}
        style={[styles.input, { color: p.text, borderColor: errorText ? p.error : p.border, backgroundColor: p.surface }]}
      />
      <Text style={{ color: p.textMuted }}>{t('operator.join.codeHint')}</Text>
      {errorText ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: p.error, fontSize: 16 }}>
          {errorText}
        </Text>
      ) : null}
      {isWaiting ? <Text style={{ color: p.warningText }}>{t('operator.join.retryIn', { seconds: waitLeft })}</Text> : null}
      <Button
        label={phase.name === 'sending' ? t('operator.join.submitting') : t('operator.join.submit')}
        onPress={() => void submit()}
        loading={phase.name === 'sending'}
        disabled={isWaiting}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: MIN_TOUCH, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 18, letterSpacing: 1 },
  card: { borderWidth: 3, borderRadius: 20, padding: 16, gap: 8 },
  ok: { fontSize: 22, fontWeight: '800' },
});
