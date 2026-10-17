import type { WebViewProps } from 'react-native-webview';

/**
 * Static, security-relevant WebView settings of the payment page (ARCHITECTURE 13.5). Kept as plain
 * data so a test can pin every one of them; `PaymentWebView` only spreads it. Not set on purpose:
 * `injectedJavaScript*` and `onMessage` (nothing is injected, the page's messages are not read),
 * `source.headers` / cookies (no token or session data ever reaches the provider page).
 */
export const LOCKED_DOWN_WEBVIEW_PROPS = {
  // react-native-webview checks `originWhitelist` as an UNANCHORED PREFIX regex on the origin
  // ("https://checkout.paycom.uz" also matches "https://checkout.paycom.uz.evil.com") and OPENS every
  // non-matching URL (intent:, tel:, market: ...) through Linking, logging the URL. Letting
  // everything reach `onShouldStartLoadWithRequest` makes `webviewPolicy` (exact host match) the
  // only gate and keeps the OS out of it.
  originWhitelist: ['*'],
  // The provider's checkout is script-driven: JavaScript is required.
  javaScriptEnabled: true,
  // Payme / Click checkouts are single-page apps that keep form state in DOM storage (not verified
  // against the real pages). iOS: discarded with the non-persistent store; Android: see 13.5.
  domStorageEnabled: true,
  incognito: true,
  cacheEnabled: false,
  sharedCookiesEnabled: false,
  saveFormDataDisabled: true,
  mixedContentMode: 'never',
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  allowsInlineMediaPlayback: false,
  geolocationEnabled: false,
  setSupportMultipleWindows: false,
  javaScriptCanOpenWindowsAutomatically: false,
  allowsLinkPreview: false,
  allowsBackForwardNavigationGestures: false,
  setBuiltInZoomControls: false,
  webviewDebuggingEnabled: false,
} as const satisfies Partial<WebViewProps>;
