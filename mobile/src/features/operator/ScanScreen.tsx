import * as Clipboard from 'expo-clipboard';
import { useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import { usePreventScreenCapture } from 'expo-screen-capture';
import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Screen } from '@/components/Screen';
import { CashPanel } from '@/features/operator/CashPanel';
import { isCashStep } from '@/features/operator/checkoutFlow';
import { GateCardView } from '@/features/operator/GateCardView';
import { effectivePlateCheck, lotCapabilities, resolveEntryPlate } from '@/features/operator/lotPolicy';
import { OperatorHeader } from '@/features/operator/OperatorHeader';
import { operatorStore, useOperatorStore } from '@/features/operator/operatorSession';
import { PlateField } from '@/features/operator/PlateField';
import { plateProblemKey } from '@/features/operator/plateText';
import { ScanCamera } from '@/features/operator/ScanCamera';
import { cameraAccess, isCameraActive, shouldWipe, validateScanText, type CameraAccess, type CameraState } from '@/features/operator/scanPolicy';
import { useFocusState, type FocusState } from '@/features/operator/useFocusState';
import { useGateScan, type ScanNotice } from '@/features/operator/useGateScan';
import { useLeaveGuard } from '@/features/operator/useLeaveGuard';
import { useActiveLot } from '@/features/operator/useOperatorLots';
import { useAuthStore } from '@/store/auth';
import { usePalette } from '@/theme/theme';

function isSameCamera(a: CameraState, b: CameraState): boolean {
  return a.isFocused === b.isFocused && a.appState === b.appState && a.access === b.access && a.mode === b.mode;
}

/**
 * Wrapper that decides WHEN the scanner body is thrown away and rebuilt: the screen was left, the
 * app went to the background (or iOS "inactive"), the camera permission changed, or Entry / Exit
 * was switched. A fresh body has no result, no token and no typed plate - wiping is a remount, not
 * a pile of effects. EXCEPT while a cash step is pending (scanPolicy.shouldWipe): then the body
 * stays, so the amount is still on screen when the operator comes back. Only the camera stops. The
 * exit QR token stays in memory for that time too (collect:true repeats the same request; the
 * manual path is refused for ONLINE bookings), and is dropped when the step ends, the operator
 * confirms leaving, the session ends or the app is killed.
 */
export function ScanScreen() {
  const focus = useFocusState();
  const mode = useOperatorStore((s) => s.mode);
  const isCashPending = useOperatorStore((s) => s.cashPending);
  const [permission, requestPermission] = useCameraPermissions();
  const access = cameraAccess(permission);
  const camera: CameraState = { isFocused: focus.isFocused, appState: focus.appState, access, mode };
  const [wipe, setWipe] = useState({ prev: camera, generation: 0 });
  if (!isSameCamera(wipe.prev, camera)) {
    setWipe({ prev: camera, generation: wipe.generation + (shouldWipe({ isCashPending }, wipe.prev, camera) ? 1 : 0) });
  }
  return (
    <ScanBody
      key={wipe.generation}
      focus={focus}
      access={access}
      mode={mode}
      onRequestPermission={() => void requestPermission()}
    />
  );
}

interface ScanBodyProps {
  focus: FocusState;
  access: CameraAccess;
  mode: 'entry' | 'exit';
  onRequestPermission: () => void;
}

/** Paste on button press only; the clipboard is emptied afterwards so the QR text does not linger there. */
async function pasteFromClipboard(setText: (text: string) => void): Promise<void> {
  try {
    const text = await Clipboard.getStringAsync();
    setText(text);
    if (validateScanText(text).ok) await Clipboard.setStringAsync('');
  } catch {
    // No clipboard access: the operator types the text instead.
  }
}

function noticeText(notice: ScanNotice, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (notice.kind === 'bad_qr') return t('operator.scan.badQr');
  if (notice.kind === 'plate_missing') return t('operator.scan.plateMissing');
  return t('operator.scan.entryLocked', { seconds: notice.seconds });
}

function ScanBody({ focus, access, mode, onRequestPermission }: ScanBodyProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const router = useRouter();
  usePreventScreenCapture();
  useKeepAwake();
  const role = useAuthStore((s) => s.user?.role);
  const { query, lot } = useActiveLot();
  const verifyPlate = useOperatorStore((s) => (lot ? (s.verifyPlate[lot.id] ?? false) : false));
  const [plateText, setPlateText] = useState('');
  const [isManualOpen, setIsManualOpen] = useState(false);
  const [manualText, setManualText] = useState('');

  const caps = lotCapabilities(lot);
  const plateCheck = effectivePlateCheck(lot, verifyPlate);
  const entryPlate = mode === 'entry' ? resolveEntryPlate(plateCheck, plateText) : ({ ok: true, plate: null } as const);

  const onWipe = useCallback((): void => {
    setPlateText('');
    setManualText('');
  }, []);

  const scan = useGateScan({
    mode,
    lotId: lot?.id ?? null,
    canCheckIn: caps.canCheckIn,
    canCheckOut: caps.canCheckOut,
    isPlateReady: entryPlate.ok,
    plate: entryPlate.ok ? entryPlate.plate : null,
    onWipe,
  });
  const { card, exitState } = scan;
  const isCash = isCashStep(exitState);
  const confirmLeave = useLeaveGuard(isCash);
  const navigation = useNavigation();
  // Tell the screen wrapper (and the swipe-back gesture) that cash is pending.
  useEffect(() => {
    operatorStore.getState().setCashPending(isCash);
    navigation.setOptions({ gestureEnabled: !isCash });
    return () => operatorStore.getState().setCashPending(false);
  }, [isCash, navigation]);
  const isCameraOn = isCameraActive({ isFocused: focus.isFocused, appState: focus.appState, access });

  if (query.isLoading) {
    return (
      <Screen>
        <OperatorHeader title={t('operator.scan.title')} />
        <ActivityIndicator accessibilityLabel={t('common.loading')} />
      </Screen>
    );
  }
  if (lot === null) {
    return (
      <Screen>
        <OperatorHeader title={t('operator.scan.title')} />
        <Text style={{ color: p.text, fontSize: 16 }}>{t('operator.scan.lotMissing')}</Text>
        <Button label={t('operator.home.title')} onPress={() => router.replace('/operator')} />
      </Screen>
    );
  }

  const platePlaceholderError =
    mode === 'entry' && plateCheck.enabled && !entryPlate.ok && plateText.trim() !== '' ? t(plateProblemKey(entryPlate.reason)) : null;
  // The typed / pasted text is cleared only when it was actually used; a refusal (bad text, plate
  // still missing, a result on screen) keeps what the operator wrote.
  const submitManual = (): void => {
    if (scan.onScanned(manualText) === 'started') setManualText('');
  };

  return (
    <Screen>
      <OperatorHeader title={t('operator.scan.title')} subtitle={lot.name} onBack={confirmLeave} />
      <View accessibilityRole="radiogroup" style={styles.modes}>
        <Chip
          label={t('operator.scan.entry')}
          selected={mode === 'entry'}
          disabled={scan.isBlocked}
          onPress={() => operatorStore.getState().setMode('entry')}
        />
        <Chip
          label={t('operator.scan.exit')}
          selected={mode === 'exit'}
          disabled={scan.isBlocked}
          onPress={() => operatorStore.getState().setMode('exit')}
        />
      </View>

      {mode === 'entry' && !caps.canCheckIn ? <Text style={{ color: p.warningText }}>{t('operator.scan.entryDisabled')}</Text> : null}
      {caps.notice ? <Text style={{ color: p.warningText }}>{t(caps.notice)}</Text> : null}

      {mode === 'entry' && caps.canCheckIn ? (
        <View style={styles.plate}>
          {plateCheck.locked ? (
            <Text style={{ color: p.textMuted }}>{t('operator.scan.plateRequiredByLot')}</Text>
          ) : (
            <Chip
              role="checkbox"
              label={t('operator.scan.plateToggle')}
              selected={plateCheck.enabled}
              disabled={scan.isBlocked}
              onPress={() => operatorStore.getState().setVerifyPlate(lot.id, !plateCheck.enabled)}
            />
          )}
          {plateCheck.enabled ? (
            <PlateField
              label={t('operator.scan.plateLabel')}
              value={plateText}
              onChange={setPlateText}
              hint={entryPlate.ok ? null : t('operator.scan.plateMissing')}
              error={platePlaceholderError}
            />
          ) : null}
        </View>
      ) : null}

      <View style={styles.cameraArea}>
        <ScanCamera access={access} isActive={isCameraOn} onRequestPermission={onRequestPermission} onScanned={scan.onScanned} />
        <View style={styles.overlay} pointerEvents="box-none">
          <ScrollView contentContainerStyle={styles.overlayBody} keyboardShouldPersistTaps="handled">
            {isCash ? (
              <CashPanel
                state={exitState}
                role={role}
                onCollect={() => scan.send({ type: 'collect' })}
                onDefer={() => scan.send({ type: 'defer' })}
                onRetry={() => scan.send({ type: 'retry' })}
                onBack={() => scan.send({ type: 'back' })}
                onOverride={(note) => scan.send({ type: 'override', note, role })}
              />
            ) : card ? (
              <GateCardView card={card} onDismiss={scan.dismiss} onRetry={scan.retry} />
            ) : scan.isBlocked ? (
              <Text style={[styles.status, { color: p.text, backgroundColor: p.surface }]}>{t('operator.scan.checking')}</Text>
            ) : scan.notice ? (
              <Text style={[styles.status, { color: p.error, backgroundColor: p.surface }]}>{noticeText(scan.notice, t)}</Text>
            ) : (
              <Text style={[styles.status, { color: p.text, backgroundColor: p.surface }]}>
                {mode === 'entry' ? t('operator.scan.hintEntry') : t('operator.scan.hintExit')}
              </Text>
            )}
          </ScrollView>
        </View>
      </View>

      <Chip
        role="checkbox"
        label={t('operator.scan.manualQr')}
        selected={isManualOpen}
        disabled={scan.isBlocked}
        onPress={() => setIsManualOpen((value) => !value)}
      />
      {isManualOpen ? (
        <View style={styles.plate}>
          <Text style={{ color: p.textMuted }}>{t('operator.scan.manualQrHint')}</Text>
          <TextInput
            accessibilityLabel={t('operator.scan.manualQrLabel')}
            value={manualText}
            onChangeText={setManualText}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            spellCheck={false}
            keyboardType="visible-password"
            maxLength={1100}
            style={[styles.manualInput, { color: p.text, borderColor: p.border, backgroundColor: p.surface }]}
          />
          <Button
            variant="secondary"
            label={t('operator.scan.manualQrPaste')}
            onPress={() => void pasteFromClipboard(setManualText)}
          />
          <Button label={t('operator.scan.manualQrSubmit')} onPress={submitManual} disabled={manualText.trim() === '' || scan.isBlocked} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  modes: { flexDirection: 'row', gap: 8 },
  plate: { gap: 8 },
  cameraArea: { flex: 1, minHeight: 220 },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'flex-end' },
  overlayBody: { flexGrow: 1, justifyContent: 'flex-end', paddingBottom: 4 },
  status: { fontSize: 18, fontWeight: '600', textAlign: 'center', padding: 12, borderRadius: 12, overflow: 'hidden' },
  manualInput: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 14 },
});
