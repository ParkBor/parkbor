import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { canCollect, MAX_OVERRIDE_NOTE, validateOverrideNote, type CheckoutState } from '@/features/operator/checkoutFlow';
import { canOverrideExit } from '@/features/operator/tabVisibility';
import { useCountdownSeconds } from '@/features/operator/useCountdownSeconds';
import { useOperatorFormat } from '@/features/operator/useFormat';
import { formatPlate } from '@/features/vehicles/vehiclePlate';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface CashPanelProps {
  state: CheckoutState;
  role: string | null | undefined;
  onCollect: () => void;
  onDefer: () => void;
  onRetry: () => void;
  onBack: () => void;
  /** OWNER / ADMIN only: settle a debt under review with a written reason. */
  onOverride: (note: string) => void;
}

/**
 * Step two of the exit: the cash due, as the server stated it. "Pul olindi" repeats the same
 * request with collect:true; a second press while it runs does nothing (the state machine refuses).
 * When the server flagged the debt for review the button is off: an OPERATOR can only acknowledge,
 * OWNER / ADMIN can settle it with a written reason (override). A failed step shows a retry button
 * only when repeating can help; a rate limit shows the wait.
 */
export function CashPanel({ state, role, onCollect, onDefer, onRetry, onBack, onOverride }: CashPanelProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const fmt = useOperatorFormat();
  const [isNoteOpen, setIsNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const failure = state.phase === 'error' ? state.failure : null;
  // A new failure restarts the wait even when its Retry-After equals the previous one (state is
  // adjusted while rendering, the recommended way to react to a changed value).
  const [seenFailure, setSeenFailure] = useState(failure);
  const [failureSeq, setFailureSeq] = useState(0);
  if (failure !== seenFailure) {
    setSeenFailure(failure);
    setFailureSeq(failureSeq + 1);
  }
  const waitLeft = useCountdownSeconds(failure?.retry === 'wait' ? failure.retryAfterSec : null, failureSeq);
  const res = state.phase === 'awaiting_cash' || state.phase === 'requesting' || state.phase === 'error' ? state.res : undefined;
  if (res === undefined) return null;

  const isBusy = state.phase === 'requesting';
  const isReview = res.overstay.needsReview;
  const mayOverride = isReview && canOverrideExit(role);

  function submitNote(): void {
    const checked = validateOverrideNote(note);
    if (!checked.ok) {
      setNoteError(t(checked.reason === 'empty' ? 'operator.manual.noteEmpty' : 'operator.manual.noteTooLong'));
      return;
    }
    onOverride(checked.note);
    setNote('');
    setIsNoteOpen(false);
  }

  return (
    <View accessible={false} style={[styles.card, { backgroundColor: p.surface, borderColor: p.warning }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: p.warningText }]}>
        {t('operator.cash.title')}
      </Text>
      <Text accessibilityLiveRegion="polite" style={[styles.amount, { color: p.text }]}>
        {fmt.money(res.toCollect)}
      </Text>
      <Text style={[styles.plate, { color: p.text }]}>{formatPlate(res.booking.plate)}</Text>
      <Text style={{ color: p.textMuted }}>{t('operator.cash.serverAmount')}</Text>
      {isReview ? (
        <View style={styles.review}>
          <Text style={[styles.reviewTitle, { color: p.warningText }]}>{t('operator.cash.reviewTitle')}</Text>
          <Text style={{ color: p.text }}>{t('operator.cash.reviewText')}</Text>
        </View>
      ) : null}
      {failure ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          // An unreadable 2xx is not a refusal: the server may have acted (amber, "check by hand").
          style={{ color: failure.reasonKey === 'operator.reason.contract' ? p.warningText : p.error, fontSize: 16, fontWeight: '600' }}
        >
          {t(failure.reasonKey)}
        </Text>
      ) : null}

      {isNoteOpen ? (
        <View style={styles.review}>
          <Text style={{ color: p.warningText }}>{t('operator.manual.noteWarning')}</Text>
          <Text style={{ color: p.text, fontWeight: '600' }}>{t('operator.manual.noteLabel')}</Text>
          <TextInput
            accessibilityLabel={t('operator.manual.noteLabel')}
            value={note}
            onChangeText={(value) => {
              setNote(value);
              setNoteError(null);
            }}
            maxLength={MAX_OVERRIDE_NOTE + 20}
            multiline
            autoCorrect={false}
            style={[styles.note, { color: p.text, borderColor: noteError ? p.error : p.border }]}
          />
          {noteError ? (
            <Text accessibilityRole="alert" style={{ color: p.error }}>
              {noteError}
            </Text>
          ) : null}
          <Button label={t('operator.manual.release')} onPress={submitNote} />
          <Button variant="secondary" label={t('operator.manual.cancel')} onPress={() => setIsNoteOpen(false)} />
        </View>
      ) : (
        <View style={styles.actions}>
          {failure ? (
            <>
              {failure.retry !== 'none' ? (
                <Button
                  label={waitLeft > 0 ? t('operator.scan.retryIn', { seconds: waitLeft }) : t('operator.scan.retry')}
                  onPress={onRetry}
                  disabled={waitLeft > 0}
                />
              ) : null}
              <Button variant="secondary" label={t('common.back')} onPress={onBack} />
            </>
          ) : isReview ? (
            <>
              {mayOverride ? <Button label={t('operator.cash.override')} onPress={() => setIsNoteOpen(true)} /> : null}
              <Button variant={mayOverride ? 'secondary' : 'primary'} label={t('operator.cash.ack')} onPress={onDefer} disabled={isBusy} loading={isBusy && !mayOverride} />
            </>
          ) : (
            <>
              <Button
                label={isBusy ? t('operator.cash.collecting') : t('operator.cash.collected')}
                onPress={onCollect}
                disabled={!canCollect(state)}
                loading={isBusy}
              />
              <Button variant="secondary" label={t('operator.cash.later')} onPress={onDefer} disabled={isBusy} />
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 3, borderRadius: 20, padding: 16, gap: 8 },
  title: { fontSize: 22, fontWeight: '800' },
  amount: { fontSize: 48, fontWeight: '800' },
  plate: { fontSize: 28, fontWeight: '700', letterSpacing: 2 },
  review: { gap: 6 },
  reviewTitle: { fontSize: 18, fontWeight: '700' },
  actions: { gap: 8, marginTop: 6 },
  note: { minHeight: MIN_TOUCH * 1.5, borderWidth: 1, borderRadius: 12, padding: 10, fontSize: 16, textAlignVertical: 'top' },
});
