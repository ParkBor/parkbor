import { describe, expect, it } from 'vitest';

import { LOCKED_DOWN_WEBVIEW_PROPS as props } from '@/features/payment/webviewProps';

describe('LOCKED_DOWN_WEBVIEW_PROPS', () => {
  it('hands every URL to the app-side policy and never to the OS', () => {
    expect(props.originWhitelist).toEqual(['*']);
  });

  it('keeps nothing on the device: incognito, no cache, no shared cookies, no saved form data', () => {
    expect(props).toMatchObject({ incognito: true, cacheEnabled: false, sharedCookiesEnabled: false, saveFormDataDisabled: true });
  });

  it('closes every file / content / mixed-content / popup / location door', () => {
    expect(props).toMatchObject({
      mixedContentMode: 'never',
      allowFileAccess: false,
      allowFileAccessFromFileURLs: false,
      allowUniversalAccessFromFileURLs: false,
      geolocationEnabled: false,
      setSupportMultipleWindows: false,
      javaScriptCanOpenWindowsAutomatically: false,
      allowsInlineMediaPlayback: false,
      allowsLinkPreview: false,
      allowsBackForwardNavigationGestures: false,
      webviewDebuggingEnabled: false,
    });
  });

  it('enables only what the provider page needs: JavaScript and DOM storage', () => {
    expect(props.javaScriptEnabled).toBe(true);
    expect(props.domStorageEnabled).toBe(true);
  });

  it('injects nothing and listens to nothing', () => {
    const keys = Object.keys(props);
    expect(keys.filter((key) => key.startsWith('injectedJavaScript') || key === 'onMessage')).toEqual([]);
  });
});
