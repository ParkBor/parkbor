import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ErrorText } from '@/components/ErrorText';
import { errorMessageKey, type WebViewErrorKind } from '@/features/payment/webviewState';
import { usePalette } from '@/theme/theme';

/** Which site the user is on (host only, never the URL). */
export function HostBar({ host }: { host: string | null }) {
  const { t } = useTranslation();
  const p = usePalette();
  if (host === null) return null;
  return (
    <Text style={[styles.host, { color: p.textMuted }]} accessibilityLabel={t('payment.webview.host', { host })}>
      {t('payment.webview.host', { host })}
    </Text>
  );
}

interface FailureViewProps {
  kind: WebViewErrorKind;
  onRetry: () => void;
  onExit: () => void;
}

/** The page could not be shown. A certificate problem offers no retry: the payment is stopped. */
export function FailureView({ kind, onRetry, onExit }: FailureViewProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.center}>
      <ErrorText message={t(errorMessageKey(kind))} />
      {kind === 'ssl' ? null : <Button label={t('payment.webview.retry')} onPress={onRetry} />}
      <Button variant="secondary" label={t('payment.webview.close')} onPress={onExit} />
    </View>
  );
}

interface BlockedNoticeProps {
  onRetry: () => void;
  onCheckStatus: () => void;
}

/** A top-level page outside the allow-list (e.g. a bank page) was refused: say so, offer a way on. */
export function BlockedNotice({ onRetry, onCheckStatus }: BlockedNoticeProps) {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <View style={[styles.notice, { backgroundColor: p.surface, borderColor: p.warningText }]} accessibilityLiveRegion="polite">
      <Text style={{ color: p.warningText }}>{t('payment.webview.blocked')}</Text>
      <View style={styles.row}>
        <Button variant="secondary" label={t('payment.webview.retry')} onPress={onRetry} />
        <Button variant="secondary" label={t('payment.webview.checkStatus')} onPress={onCheckStatus} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { fontSize: 12, paddingHorizontal: 24, paddingBottom: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  notice: { borderWidth: 1, borderRadius: 12, padding: 12, marginHorizontal: 12, gap: 8 },
  row: { gap: 8 },
});
