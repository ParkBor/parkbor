import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Screen } from '@/components/Screen';
import { classifyOperatorError, withAutoRetry } from '@/features/operator/gateErrors';
import { operatorStore, useOperatorStore } from '@/features/operator/operatorSession';
import { shouldWipe, type CameraState } from '@/features/operator/scanPolicy';
import { lotCapabilities } from '@/features/operator/lotPolicy';
import { ManualExit } from '@/features/operator/ManualExit';
import { operatorApi } from '@/features/operator/operatorApi';
import { OperatorHeader } from '@/features/operator/OperatorHeader';
import type { WalkInResult } from '@/features/operator/operatorSchemas';
import { PlateField } from '@/features/operator/PlateField';
import { plateProblemKey } from '@/features/operator/plateText';
import { nextFreeSlot, selectableSlots, validateWalkIn, VEHICLE_TYPES, type WalkInErrors } from '@/features/operator/walkInForm';
import { useAutoDismiss } from '@/features/operator/useCardLifecycle';
import { useCountdownSeconds } from '@/features/operator/useCountdownSeconds';
import { useFocusState } from '@/features/operator/useFocusState';
import { useOperatorFormat } from '@/features/operator/useFormat';
import { operatorKeys, useActiveLot } from '@/features/operator/useOperatorLots';
import { useSlotMap } from '@/features/operator/useSlotMap';
import { formatPlate } from '@/features/vehicles/vehiclePlate';
import { useAuthStore } from '@/store/auth';
import { usePalette } from '@/theme/theme';

const MAX_SLOT_CHIPS = 24;

/**
 * Walk-in registration (no booking) and manual exit. The body is rebuilt (remounted) when the screen
 * is left or the app goes to the background / iOS "inactive": the form, the success card and any
 * override note then disappear - EXCEPT while a cash step is pending (scanPolicy.shouldWipe), which
 * must still be there when the operator comes back.
 */
export function WalkInScreen() {
  const focus = useFocusState();
  const isCashPending = useOperatorStore((s) => s.cashPending);
  // No camera here: reuse the same wipe rule with a permanently granted "camera".
  const state: CameraState = { isFocused: focus.isFocused, appState: focus.appState, access: 'granted', mode: 'entry' };
  const [wipe, setWipe] = useState({ prev: state, generation: 0 });
  if (wipe.prev.isFocused !== state.isFocused || wipe.prev.appState !== state.appState) {
    setWipe({ prev: state, generation: wipe.generation + (shouldWipe({ isCashPending }, wipe.prev, state) ? 1 : 0) });
  }
  return <WalkInBody key={wipe.generation} />;
}

function WalkInBody() {
  usePreventScreenCapture();
  const { t } = useTranslation();
  const p = usePalette();
  const fmt = useOperatorFormat();
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const { query: lotsQuery, lot } = useActiveLot();
  const map = useSlotMap(lot?.id ?? null);
  const caps = lotCapabilities(lot);

  const [slotId, setSlotId] = useState<string | null>(null);
  const [plate, setPlate] = useState('');
  const [vehicleType, setVehicleType] = useState<string | null>(null);
  const [errors, setErrors] = useState<WalkInErrors>({});
  const [errorText, setErrorText] = useState<string | null>(null);
  const [done, setDone] = useState<WalkInResult | null>(null);
  const [waitSec, setWaitSec] = useState<number | null>(null);
  const [failureCount, setFailureCount] = useState(0);
  const waitLeft = useCountdownSeconds(waitSec, failureCount);
  const [isLost, setIsLost] = useState(false);
  const isMounted = useRef(true);

  const register = useMutation({
    mutationFn: (payload: Parameters<typeof operatorApi.walkIn>[0]) => withAutoRetry(() => operatorApi.walkIn(payload)),
    // The plate travels in the mutation variables: do not keep them in the query cache.
    gcTime: 0,
    onSuccess: (result) => {
      // The screen was left while the request ran: the car IS registered, nobody saw it.
      if (isMounted.current) setDone(result);
      else operatorStore.getState().markLostResult('walk_in');
      if (lot) void queryClient.invalidateQueries({ queryKey: operatorKeys.slots(lot.id) });
    },
    onError: (error) => {
      const failure = classifyOperatorError(error);
      setErrorText(t(failure.reasonKey));
      setWaitSec(failure.retry === 'wait' ? failure.retryAfterSec : null);
      setFailureCount((value) => value + 1);
      // slot_occupied, plate_busy, ... usually mean the map is stale: look again.
      void map.refetch();
    },
  });

  const { reset: resetMutation } = register;
  useEffect(() => {
    isMounted.current = true;
    // One-shot external flag read on mount: a walk-in / manual exit whose answer was not shown.
    if (operatorStore.getState().takeLostResult('walk_in')) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsLost(true);
    }
    return () => {
      isMounted.current = false;
      resetMutation();
    };
  }, [resetMutation]);

  const slots = map.data?.slots ?? [];
  // Gap rule evaluated at the time of the last map refresh (stable between renders).
  const nowMs = map.dataUpdatedAt;
  const choices = selectableSlots(slots, vehicleType, nowMs);

  function submit(): void {
    setErrorText(null);
    const checked = validateWalkIn({ slotId, plate, vehicleType });
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    register.mutate(checked.payload);
  }

  const reset = useCallback((): void => {
    setWaitSec(null);
    resetMutation();
    setDone(null);
    setPlate('');
    setSlotId(null);
    setErrors({});
    setErrorText(null);
  }, [resetMutation]);

  useAutoDismiss({ isShown: done !== null, tone: 'green', needsAction: false, onDismiss: reset });

  if (lotsQuery.isLoading) {
    return (
      <Screen>
        <OperatorHeader title={t('operator.walkIn.title')} />
        <ActivityIndicator accessibilityLabel={t('common.loading')} />
      </Screen>
    );
  }
  if (lot === null) {
    return (
      <Screen>
        <OperatorHeader title={t('operator.walkIn.title')} />
        <Text style={{ color: p.text }}>{t('operator.scan.lotMissing')}</Text>
      </Screen>
    );
  }

  const chosen = slots.find((slot) => slot.id === slotId) ?? null;

  return (
    <Screen isForm>
      <OperatorHeader title={t('operator.walkIn.title')} subtitle={lot.name} />
      {caps.notice ? <Text style={{ color: p.warningText }}>{t(caps.notice)}</Text> : null}
      {isLost ? (
        <View style={[styles.card, { borderColor: p.warning, backgroundColor: p.surface }]}>
          <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={[styles.ok, { color: p.warningText }]}>
            ! {t('operator.walkIn.lost')}
          </Text>
          <Button variant="secondary" label={t('operator.card.dismiss')} onPress={() => setIsLost(false)} />
        </View>
      ) : null}

      {done ? (
        <View style={[styles.card, { borderColor: p.success, backgroundColor: p.surface }]}>
          <Text accessibilityLiveRegion="polite" style={[styles.ok, { color: p.successText }]}>
            ✓ {t('operator.walkIn.success', { plate: formatPlate(done.booking.plate), slot: done.booking.slot.code })}
          </Text>
          <Text style={{ color: p.text, fontSize: 18 }}>{t('operator.walkIn.validUntil', { time: fmt.clock(done.validUntilMs) })}</Text>
          <Button label={t('operator.walkIn.another')} onPress={reset} />
        </View>
      ) : caps.canWalkIn ? (
        <View style={styles.form}>
          <Text style={[styles.label, { color: p.text }]}>{t('operator.walkIn.vehicleType')}</Text>
          <View style={styles.chips} accessibilityRole="radiogroup">
            {VEHICLE_TYPES.map((type) => (
              <Chip
                key={type}
                label={t(`vehicles.type_${type}`)}
                selected={vehicleType === type}
                onPress={() => {
                  setVehicleType(type);
                  setSlotId(null);
                }}
              />
            ))}
          </View>
          {errors.vehicleType ? <Text style={{ color: p.error }}>{t('operator.walkIn.vehicleTypeRequired')}</Text> : null}

          <PlateField
            testID="walkin-plate-input"
            label={t('operator.walkIn.plate')}
            value={plate}
            onChange={(value) => {
              setPlate(value);
              if (errors.plate) setErrors((prev) => ({ ...prev, plate: undefined }));
            }}
            error={errors.plate ? t(plateProblemKey(errors.plate)) : null}
          />

          <Text style={[styles.label, { color: p.text }]}>{t('operator.walkIn.slot')}</Text>
          {map.isError ? <Text style={{ color: p.error }}>{t('operator.walkIn.loadError')}</Text> : null}
          <Button
            variant="secondary"
            label={t('operator.walkIn.nextFree')}
            onPress={() => {
              const next = nextFreeSlot(slots, vehicleType, nowMs);
              setSlotId(next?.id ?? null);
              if (!next) setErrorText(t('operator.walkIn.noFree'));
              else setErrorText(null);
            }}
            disabled={map.isPending}
          />
          <View style={styles.chips} accessibilityRole="radiogroup">
            {choices.slice(0, MAX_SLOT_CHIPS).map((slot) => (
              <Chip key={slot.id} label={slot.code} selected={slot.id === slotId} onPress={() => setSlotId(slot.id)} />
            ))}
          </View>
          {choices.length > MAX_SLOT_CHIPS ? (
            <Text style={{ color: p.textMuted }}>{t('operator.walkIn.moreSlots', { count: choices.length - MAX_SLOT_CHIPS })}</Text>
          ) : null}
          {choices.length === 0 && !map.isPending ? <Text style={{ color: p.textMuted }}>{t('operator.walkIn.noFree')}</Text> : null}
          <Text style={{ color: p.text }}>{chosen ? `${t('operator.walkIn.slot')}: ${chosen.code}` : t('operator.walkIn.slotNone')}</Text>
          {errors.slot ? <Text style={{ color: p.error }}>{t('operator.walkIn.slotRequired')}</Text> : null}

          {errorText ? (
            <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: p.error, fontSize: 16 }}>
              {errorText}
            </Text>
          ) : null}
          {waitLeft > 0 ? <Text style={{ color: p.warningText }}>{t('operator.scan.retryIn', { seconds: waitLeft })}</Text> : null}
          <Button label={t('operator.walkIn.submit')} onPress={submit} loading={register.isPending} disabled={waitLeft > 0} />
        </View>
      ) : (
        <Text style={{ color: p.textMuted }}>{t('operator.walkIn.disabled')}</Text>
      )}

      {caps.canCheckOut ? (
        <View style={styles.manual}>
          <ManualExit lotId={lot.id} slots={slots} role={role} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12 },
  label: { fontSize: 15, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: { borderWidth: 3, borderRadius: 20, padding: 16, gap: 10 },
  ok: { fontSize: 22, fontWeight: '800' },
  manual: { paddingBottom: 24 },
});
