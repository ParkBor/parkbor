/** A page that has not finished loading after this long is reported as a timeout (task: 15-20 s). */
export const LOAD_TIMEOUT_MS = 20_000;

export type WebViewErrorKind = 'load' | 'offline' | 'ssl' | 'timeout' | 'http' | 'process';
export type WebViewPhase = 'loading' | 'ready' | 'error';

export interface WebViewState {
  readonly phase: WebViewPhase;
  readonly error: WebViewErrorKind | null;
  /** Bumped by every retry; used as the WebView `key` so a retry is a fresh instance. */
  readonly attempt: number;
  /** Page loads started so far: re-arms the load watchdog for every navigation. */
  readonly navigations: number;
  /** Top-level navigations the policy refused (the user is told; the URLs are not kept). */
  readonly blockedCount: number;
}

export type WebViewEvent =
  | { type: 'loadStart' }
  | { type: 'loadEnd' }
  | { type: 'timeout' }
  | { type: 'error'; kind: WebViewErrorKind }
  | { type: 'httpError'; statusCode: number }
  | { type: 'blocked' }
  | { type: 'retry' };

const HTTP_ERROR_FROM = 400;

export function initialWebViewState(): WebViewState {
  return { phase: 'loading', error: null, attempt: 0, navigations: 0, blockedCount: 0 };
}

/** An error is final until the user retries: a stray late `loadEnd` must not hide it. */
export function reduceWebView(state: WebViewState, event: WebViewEvent): WebViewState {
  if (event.type === 'retry') return { phase: 'loading', error: null, attempt: state.attempt + 1, navigations: 0, blockedCount: 0 };
  if (state.phase === 'error') return state;
  switch (event.type) {
    case 'loadStart':
      return { ...state, phase: 'loading', navigations: state.navigations + 1 };
    case 'loadEnd':
      return { ...state, phase: 'ready' };
    case 'timeout':
      return state.phase === 'loading' ? { ...state, phase: 'error', error: 'timeout' } : state;
    case 'error':
      return { ...state, phase: 'error', error: event.kind };
    case 'blocked':
      return { ...state, blockedCount: state.blockedCount + 1 };
    case 'httpError':
      return event.statusCode >= HTTP_ERROR_FROM ? { ...state, phase: 'error', error: 'http' } : state;
  }
}

const SSL_PATTERN = /ssl|cert|secure connection|trust/i;
const OFFLINE_PATTERN = /internet|offline|name_not_resolved|disconnected|network_changed|not connected|connection_(?:refused|reset|closed)/i;
const TIMEOUT_PATTERN = /timed?[ _-]?out/i;
const IOS_OFFLINE_CODES: ReadonlySet<number> = new Set([-1009, -1004, -1003]);
const IOS_TIMEOUT_CODE = -1001;
const IOS_SSL_CODES: ReadonlySet<number> = new Set([-1200, -1201, -1202, -1203, -1204, -1205, -1206]);

/**
 * WebView `onError` event -> a kind. Only fixed categories leave this function: the raw
 * description and the failing URL are never kept (they may contain the payment URL).
 */
export function classifyLoadError(event: unknown, isDeviceOffline = false): WebViewErrorKind {
  const info = typeof event === 'object' && event !== null ? (event as { code?: unknown; description?: unknown }) : {};
  const description = typeof info.description === 'string' ? info.description : '';
  const code = typeof info.code === 'number' ? info.code : null;
  if ((code !== null && IOS_SSL_CODES.has(code)) || SSL_PATTERN.test(description)) return 'ssl';
  if ((code !== null && IOS_OFFLINE_CODES.has(code)) || OFFLINE_PATTERN.test(description)) return 'offline';
  if (code === IOS_TIMEOUT_CODE || TIMEOUT_PATTERN.test(description)) return 'timeout';
  return isDeviceOffline ? 'offline' : 'load';
}

export function errorMessageKey(kind: WebViewErrorKind): string {
  return `payment.webview.error.${kind}`;
}
