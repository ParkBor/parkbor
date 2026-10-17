import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import type { WebView, WebViewProps } from 'react-native-webview';

import { isPaymentSandbox } from '@/features/payment/paymentSandbox';
import { displayHost } from '@/features/payment/paymentUrl';
import { createNavigationGuard, decideNavigationState, decideStartLoad } from '@/features/payment/webviewPolicy';
import {
  classifyLoadError,
  initialWebViewState,
  LOAD_TIMEOUT_MS,
  reduceWebView,
  type WebViewState,
} from '@/features/payment/webviewState';

type StartRequest = Parameters<NonNullable<WebViewProps['onShouldStartLoadWithRequest']>>[0];

interface SessionOptions {
  onResult: () => void;
  isDeviceOffline: () => boolean;
}

export interface WebViewSession {
  state: WebViewState;
  /** Host of the page the user is on (never a URL). */
  host: string | null;
  handlers: Pick<
    WebViewProps,
    | 'onShouldStartLoadWithRequest'
    | 'onNavigationStateChange'
    | 'onLoadStart'
    | 'onLoadEnd'
    | 'onError'
    | 'onHttpError'
    | 'onRenderProcessGone'
    | 'onContentProcessDidTerminate'
  >;
  retry: () => void;
  /** Best-effort wipe of cache / history / form data. Call BEFORE the view is unmounted. */
  clearBrowserState: () => void;
}

/**
 * State and handlers of the payment WebView: the navigation gate, the second line of defence, the
 * load watchdog and the cleanup. Every handler is stable (the WebView is memoised and the Android
 * `shouldOverrideUrlLoading` answer has a very short native timeout, so re-renders must stay rare).
 * The URLs seen here are never logged and never stored.
 */
export function useWebViewSession({ onResult, isDeviceOffline }: SessionOptions): [WebViewSession, RefObject<WebView | null>] {
  const [state, dispatch] = useReducer(reduceWebView, undefined, initialWebViewState);
  const [host, setHost] = useState<string | null>(null);
  const guard = useMemo(() => createNavigationGuard({ sandbox: isPaymentSandbox() }), []);
  const webViewRef = useRef<WebView | null>(null);
  const hasSignalled = useRef(false);

  // The native view is gone by the time an unmount cleanup runs (React detaches the ref first and the
  // library ignores commands then), so cleaning must happen before leaving: see `PaymentWebViewHandle`.
  const clearBrowserState = useCallback((): void => {
    try {
      webViewRef.current?.clearCache?.(true);
      webViewRef.current?.clearHistory?.();
      webViewRef.current?.clearFormData?.();
    } catch {
      // nothing to clear
    }
  }, []);

  const finish = useCallback((): void => {
    if (hasSignalled.current) return;
    hasSignalled.current = true;
    clearBrowserState();
    onResult();
  }, [clearBrowserState, onResult]);

  const inspect = useCallback(
    (url: unknown): void => {
      const verdict = decideNavigationState(url, { sandbox: isPaymentSandbox() });
      if (verdict === 'result') finish();
      else if (verdict === 'violation') dispatch({ type: 'error', kind: 'load' });
      else {
        const next = displayHost(url);
        if (next !== null) setHost(next);
      }
    },
    [finish],
  );

  const handlers = useMemo<WebViewSession['handlers']>(
    () => ({
      onShouldStartLoadWithRequest: (request: StartRequest): boolean => {
        const decision = decideStartLoad(guard, request);
        if (decision.effect === 'result') finish();
        else if (decision.effect === 'blockedTop') dispatch({ type: 'blocked' });
        return decision.shouldStart;
      },
      onNavigationStateChange: (navigation) => inspect(navigation.url),
      onLoadStart: (event) => {
        dispatch({ type: 'loadStart' });
        inspect(event.nativeEvent.url);
      },
      onLoadEnd: () => dispatch({ type: 'loadEnd' }),
      onError: (event) => dispatch({ type: 'error', kind: classifyLoadError(event.nativeEvent, isDeviceOffline()) }),
      onHttpError: (event) => dispatch({ type: 'httpError', statusCode: event.nativeEvent.statusCode }),
      onRenderProcessGone: () => dispatch({ type: 'error', kind: 'process' }),
      onContentProcessDidTerminate: () => dispatch({ type: 'error', kind: 'process' }),
    }),
    [guard, finish, inspect, isDeviceOffline],
  );

  // Load watchdog: re-armed by every navigation, cleared once the page is ready or failed.
  const { phase, attempt, navigations } = state;
  useEffect(() => {
    if (phase !== 'loading') return undefined;
    const id = setTimeout(() => dispatch({ type: 'timeout' }), LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [phase, attempt, navigations]);

  const retry = useCallback((): void => {
    guard.reset();
    hasSignalled.current = false;
    dispatch({ type: 'retry' });
  }, [guard]);

  return [{ state, host, handlers, retry, clearBrowserState }, webViewRef];
}
