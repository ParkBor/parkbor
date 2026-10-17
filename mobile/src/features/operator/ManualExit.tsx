import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { CashPanel } from '@/features/operator/CashPanel';
import {
  checkoutCard,
  isCashStep,
  manualExitCandidates,
  validateOverrideNote,
  MAX_OVERRIDE_NOTE,
  type ManualExitCandidate,
} from '@/features/operator/checkoutFlow';
import { GateCardView } from '@/features/operator/GateCardView';
import { operatorStore } from '@/features/operator/operatorSession';
import { useCardLifecycle } from '@/features/operator/useCardLifecycle';
import type { MapSlot } from '@/features/operator/operatorSchemas';
import { useCheckoutFlow } from '@/features/operator/useCheckoutFlow';
import { useOperatorFormat } from '@/features/operator/useFormat';
import { formatPlate } from '@/features/vehicles/vehiclePlate';
import { MIN_TOUCH, usePalette } from '@/theme/theme';

interface ManualExitProps {
  lotId: string;
  slots: readonly MapSlot[];
  role: string | null | undefined;
}

/**
 * Release a car without its exit QR. Walk-ins: any operator (booking id + plate from the map).
 * ONLINE cars are listed ONLY for OWNER / ADMIN, with a mandatory written reason (override) - an
 * operator gets exit_qr_required from the server anyway; the UI just does not offer the path.
 */
export function ManualExit({ lotId, slots, role }: ManualExitProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const fmt = useOperatorFormat();
  const flow = useCheckoutFlow(lotId, 'walk_in');
  const [overrideFor, setOverrideFor] = useState<ManualExitCandidate | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const candidates = manualExitCandidates(slots, role);
  const card = checkoutCard(flow.state);
  const { state } = flow;
  // Same lifetime as scanner cards (5-8 s, never while cash is pending or a screen reader is on).
  useCardLifecycle(card, flow.reset);
  // While cash is pending the screen must not be rebuilt (scanPolicy.shouldWipe).
  const isCash = isCashStep(state);
  useEffect(() => {
    operatorStore.getState().setCashPending(isCash);
    return () => operatorStore.getState().setCashPending(false);
  }, [isCash]);

  function release(candidate: ManualExitCandidate, overrideNote?: string): void {
    flow.send({
      type: 'start',
      target: {
        kind: 'manual',
        bookingId: candidate.bookingId,
        plate: candidate.plate,
        ...(overrideNote ? { overrideNote } : {}),
      },
    });
  }

  function onRelease(candidate: ManualExitCandidate): void {
    if (candidate.needsOverride) {
      setOverrideFor(candidate);
      setNote('');
      setNoteError(null);
      return;
    }
    Alert.alert(t('operator.manual.confirmTitle'), t('operator.manual.confirmText', { plate: formatPlate(candidate.plate), slot: candidate.slotCode }), [
      { text: t('operator.manual.cancel'), style: 'cancel' },
      { text: t('operator.manual.release'), onPress: () => release(candidate) },
    ]);
  }

  function onOverride(): void {
    const checked = validateOverrideNote(note);
    if (!checked.ok) {
      setNoteError(t(checked.reason === 'empty' ? 'operator.manual.noteEmpty' : 'operator.manual.noteTooLong'));
      return;
    }
    if (overrideFor) release(overrideFor, checked.note);
    setOverrideFor(null);
    setNote('');
  }

  if (isCash) {
    return (
      <CashPanel
        state={state}
        role={role}
        onOverride={(overrideNote) => flow.send({ type: 'override', note: overrideNote, role })}
        onCollect={() => flow.send({ type: 'collect' })}
        onDefer={() => flow.send({ type: 'defer' })}
        onRetry={() => flow.send({ type: 'retry' })}
        onBack={() => flow.send({ type: 'back' })}
      />
    );
  }
  if (card) {
    return <GateCardView card={card} onDismiss={flow.reset} onRetry={() => flow.send({ type: 'retry' })} />;
  }

  return (
    <View style={styles.root}>
      <Text accessibilityRole="header" style={[styles.title, { color: p.text }]}>
        {t('operator.manual.title')}
      </Text>
      <Text style={{ color: p.textMuted }}>{t('operator.manual.hint')}</Text>
      {role === 'OWNER' || role === 'ADMIN' ? <Text style={{ color: p.textMuted }}>{t('operator.manual.hintOverride')}</Text> : null}
      {candidates.length === 0 ? <Text style={{ color: p.textMuted }}>{t('operator.manual.none')}</Text> : null}
      {candidates.map((candidate) => (
        <View key={candidate.bookingId} style={[styles.row, { borderColor: p.border, backgroundColor: p.surface }]}>
          <Text style={[styles.plate, { color: p.text }]}>{formatPlate(candidate.plate)}</Text>
          <Text style={{ color: p.textMuted }}>
            {candidate.slotCode} · {fmt.clock(candidate.sinceMs)}
            {candidate.needsOverride ? ` · ${t('operator.slots.online')}` : ` · ${t('operator.card.walkInTag')}`}
          </Text>
          <Button
            variant="secondary"
            label={candidate.needsOverride ? t('operator.manual.override') : t('operator.manual.release')}
            onPress={() => onRelease(candidate)}
            loading={state.phase === 'requesting'}
          />
        </View>
      ))}
      {overrideFor ? (
        <View style={[styles.row, { borderColor: p.warning, backgroundColor: p.surface }]}>
          <Text style={[styles.plate, { color: p.text }]}>{formatPlate(overrideFor.plate)}</Text>
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
          <Button label={t('operator.manual.release')} onPress={onOverride} />
          <Button variant="secondary" label={t('operator.manual.cancel')} onPress={() => setOverrideFor(null)} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  title: { fontSize: 20, fontWeight: '700' },
  row: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6 },
  plate: { fontSize: 24, fontWeight: '800', letterSpacing: 1.5 },
  note: { minHeight: MIN_TOUCH * 1.5, borderWidth: 1, borderRadius: 12, padding: 10, fontSize: 16, textAlignVertical: 'top' },
});
