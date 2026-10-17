import { CameraView, type BarcodeSettings } from 'expo-camera';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import type { CameraAccess } from '@/features/operator/scanPolicy';
import { usePalette } from '@/theme/theme';

/** QR only: nothing else is decoded. */
const QR_ONLY: BarcodeSettings = { barcodeTypes: ['qr'] };
/** The aiming frame must be visible on a camera image in both light and dark mode. */
const FRAME_COLOR = '#FFFFFF';

interface ScanCameraProps {
  access: CameraAccess;
  /** Focused + foreground + permission: the camera is mounted only then (unmounting stops it on Android). */
  isActive: boolean;
  onRequestPermission: () => void;
  /** Raw QR text; the handler decides (validation, gate). */
  onScanned: (text: string) => void;
}

/**
 * Full-screen QR camera. Frames are never captured or stored: only the live preview and the
 * barcode callback are used. A mount error is not permanent: the operator can restart the camera.
 */
export function ScanCamera({ access, isActive, onRequestPermission, onScanned }: ScanCameraProps) {
  const { t } = useTranslation();
  const p = usePalette();
  const [mountError, setMountError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  if (access === 'loading') return <Notice text={t('operator.scan.cameraLoading')} />;
  if (access === 'ask') {
    return (
      <Notice title={t('operator.scan.cameraTitle')} text={t('operator.scan.cameraText')}>
        <Button label={t('operator.scan.cameraAllow')} onPress={onRequestPermission} />
      </Notice>
    );
  }
  if (access === 'settings') {
    return (
      <Notice title={t('operator.scan.cameraTitle')} text={t('operator.scan.cameraSettingsText')}>
        <Button label={t('operator.scan.cameraSettings')} onPress={() => void Linking.openSettings()} />
      </Notice>
    );
  }
  if (mountError) {
    return (
      <Notice text={t('operator.scan.cameraUnavailable')}>
        <Button
          label={t('operator.scan.cameraRetry')}
          onPress={() => {
            setMountError(false);
            setAttempt((value) => value + 1);
          }}
        />
      </Notice>
    );
  }
  if (!isActive) return <View style={[styles.fill, { backgroundColor: p.surface }]} />;

  return (
    <View style={styles.fill}>
      <CameraView
        key={attempt}
        style={styles.fill}
        facing="back"
        active
        mute
        barcodeScannerSettings={QR_ONLY}
        onBarcodeScanned={(result) => onScanned(result.data)}
        onMountError={() => setMountError(true)}
        accessibilityLabel={t('operator.scan.preview')}
      />
      <View pointerEvents="none" style={styles.frameWrap}>
        <View style={[styles.frame, { borderColor: FRAME_COLOR }]} />
      </View>
    </View>
  );
}

interface NoticeProps {
  title?: string;
  text: string;
  children?: ReactNode;
}

function Notice({ title, text, children }: NoticeProps) {
  const p = usePalette();
  return (
    <View style={[styles.fill, styles.notice, { backgroundColor: p.surface }]}>
      {title ? (
        <Text accessibilityRole="header" style={[styles.noticeTitle, { color: p.text }]}>
          {title}
        </Text>
      ) : null}
      <Text style={[styles.noticeText, { color: p.textMuted }]}>{text}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, borderRadius: 16, overflow: 'hidden' },
  notice: { alignItems: 'stretch', justifyContent: 'center', padding: 24, gap: 12 },
  noticeTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  noticeText: { fontSize: 16, textAlign: 'center' },
  frameWrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 240, height: 240, borderWidth: 4, borderRadius: 24 },
});
