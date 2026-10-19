import { memo, useImperativeHandle, type Ref, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { ErrorText } from '@/components/ErrorText';
import { isAllowedPaymentUrl } from '@/features/payment/paymentUrl';
import { useWebViewSession } from '@/features/payment/useWebViewSession';
import { BlockedNotice, FailureView, HostBar } from '@/features/payment/WebViewNotices';
import { LOCKED_DOWN_WEBVIEW_PROPS } from '@/features/payment/webviewProps';
import { errorMessageKey } from '@/features/payment/webviewState';
import { usePalette } from '@/theme/theme';

export interface PaymentWebViewHandle {
  /** Wipe the page's cache / history / form data. Call BEFORE navigating away from the screen. */
  clearSession: () => void;
}

interface PaymentWebViewProps {
  /** Already checked by `payAvailability`; checked once more here before it is loaded. */
  url: string;
  /** The provider returned to `parkbor://payment/result`. Only a signal. */
  onResult: () => void;
  /** The user wants out (close). The caller decides what that means. */
  onExit: () => void;
  /** "Check the payment status" without waiting for the provider. */
  onCheckStatus: () => void;
  /** Asked when a load error happens, to tell "no internet" from a server problem. */
  isDeviceOffline: () => boolean;
  ref?: Ref<PaymentWebViewHandle>;
}

/**
 * The provider's checkout page, locked down per ARCHITECTURE 13.5 (settings: `webviewProps`, gate:
 * `webviewPolicy`). No token, header or session data is passed in - only the server-provided URL.
 * Memoised with stable props: the parent must not re-render this tree every second.
 */
function PaymentWebViewBase({ url, onResult, onExit, onCheckStatus, isDeviceOffline, ref }: PaymentWebViewProps) {
  const { t } = useTranslation();
  const [session, webViewRef] = useWebViewSession({ onResult, isDeviceOffline });
  const { state, host, retry } = session;
  useImperativeHandle(ref, () => ({ clearSession: session.clearBrowserState }), [session.clearBrowserState]);

  if (!isAllowedPaymentUrl(url)) return <ErrorText message={t(errorMessageKey('load'))} />;

  return (
    <View testID="payment-webview" style={styles.root} accessibilityLabel={t('payment.webview.pageLabel')}>
      <HostBar host={host} />
      {state.blockedCount > 0 ? <BlockedNotice onRetry={retry} onCheckStatus={onCheckStatus} /> : null}
      {state.phase === 'error' && state.error !== null ? (
        <FailureView kind={state.error} onRetry={retry} onExit={onExit} />
      ) : (
        <WebViewSurface url={url} session={session} viewRef={webViewRef} />
      )}
    </View>
  );
}

interface SurfaceProps {
  url: string;
  session: ReturnType<typeof useWebViewSession>[0];
  viewRef: RefObject<WebView | null>;
}

function WebViewSurface({ url, session, viewRef }: SurfaceProps) {
  const { t } = useTranslation();
  const p = usePalette();
  return (
    <>
      <WebView
        key={session.state.attempt}
        ref={viewRef}
        source={{ uri: url }}
        style={styles.web}
        {...LOCKED_DOWN_WEBVIEW_PROPS}
        {...session.handlers}
      />
      {session.state.phase === 'loading' ? (
        <View style={[styles.overlay, { backgroundColor: p.background }]} pointerEvents="none">
          <ActivityIndicator color={p.primary} accessibilityLabel={t('payment.webview.loading')} />
          <Text style={{ color: p.textMuted }}>{t('payment.webview.loading')}</Text>
        </View>
      ) : null}
    </>
  );
}

export const PaymentWebView = memo(PaymentWebViewBase);

const styles = StyleSheet.create({
  root: { flex: 1 },
  web: { flex: 1 },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center', gap: 8, opacity: 0.92 },
});
