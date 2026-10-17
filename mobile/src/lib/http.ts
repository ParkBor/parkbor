import {
  AxiosHeaders,
  create as createAxios,
  type AxiosAdapter,
  type AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';

import { SessionExpiredError } from '@/lib/refresh';

declare module 'axios' {
  interface InternalAxiosRequestConfig {
    /** Set on the retried request so a second 401 is surfaced instead of looping. */
    _retried?: boolean;
  }
}

export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Endpoints called WITHOUT credentials (explicit allowlist). Everything else -
 * including /auth/logout - carries the Bearer token and gets the 401 -> refresh -> retry.
 */
const PUBLIC_PATH_PREFIXES = ['/auth/telegram/'] as const;
const PUBLIC_PATHS = ['/auth/token/refresh'] as const;
/** Traversal / smuggling shapes: dot segments, encoded dots or slashes, doubled or back slashes. */
const SUSPICIOUS_PATH = /\.\.|%2e|%2f|%5c|\/\/|\\/i;

export function isPublicPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0] ?? '';
  if (SUSPICIOUS_PATH.test(path)) return false;
  return (
    PUBLIC_PATHS.some((p) => path === p) ||
    PUBLIC_PATH_PREFIXES.some((p) => path.startsWith(p) && path.length > p.length)
  );
}

/** Headers that must never travel inside an error object: credentials and booking replay keys. */
const SENSITIVE_HEADERS = new Set(['authorization', 'idempotency-key']);

function stripAuthorization(headers: unknown): void {
  if (headers instanceof AxiosHeaders) {
    headers.delete('Authorization');
    headers.delete('Idempotency-Key');
    return;
  }
  if (typeof headers !== 'object' || headers === null) return;
  const record = headers as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) delete record[key];
  }
}

/**
 * Removes credentials and payloads from an error before it can reach logs or UI: request
 * headers/body/params, the platform request object (React Native's XHR keeps headers and the
 * full URL, query string included) and anything `toJSON` would serialise.
 */
export function sanitizeAxiosError<E extends AxiosError>(error: E): E {
  for (const config of [error.config, error.response?.config]) {
    if (!config) continue;
    stripAuthorization(config.headers);
    config.data = undefined;
    config.params = undefined;
  }
  error.request = undefined;
  if (error.response) error.response.request = undefined;
  error.toJSON = () => ({
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.response?.status,
  });
  return error;
}

/** Installs the sanitizer as the last response interceptor of a client. */
export function attachErrorSanitizer(client: AxiosInstance): void {
  client.interceptors.response.use(undefined, (error: unknown) => {
    throw isAxiosErrorLike(error) ? sanitizeAxiosError(error) : error;
  });
}

function isAxiosErrorLike(error: unknown): error is AxiosError {
  return typeof error === 'object' && error !== null && (error as AxiosError).isAxiosError === true;
}

export interface HttpDeps {
  baseURL: string;
  getAccessToken: () => string | null;
  /** Session generation; a request is never replayed with another session's credentials. */
  getSessionEpoch: () => number;
  refresher: { refresh(): Promise<string> };
  /** Called once the refresh token was rejected: clear the session, go to login. */
  onSessionExpired: () => void;
  adapter?: AxiosAdapter;
}

interface SentWith {
  token: string | null;
  epoch: number;
}

function retryConfig(config: InternalAxiosRequestConfig): InternalAxiosRequestConfig {
  return { ...config, headers: new AxiosHeaders(config.headers), _retried: true };
}

export function createHttp(deps: HttpDeps): AxiosInstance {
  const http = createAxios({
    baseURL: deps.baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    allowAbsoluteUrls: false,
    headers: { Accept: 'application/json' },
    ...(deps.adapter ? { adapter: deps.adapter } : {}),
  });

  // What each request was sent with. Kept OUT of the config object (a WeakMap), so the
  // access token can never travel inside an error that reaches logs or UI.
  const sentWith = new WeakMap<object, SentWith>();

  function authorize(config: InternalAxiosRequestConfig, token: string, epoch: number): InternalAxiosRequestConfig {
    config.headers.set('Authorization', `Bearer ${token}`);
    sentWith.set(config, { token, epoch });
    return config;
  }

  http.interceptors.request.use((config) => {
    const token = deps.getAccessToken();
    const epoch = deps.getSessionEpoch();
    sentWith.set(config, { token: token && !isPublicPath(config.url) ? token : null, epoch });
    if (token && !isPublicPath(config.url)) authorize(config, token, epoch);
    return config;
  });

  // Parallel callers share one rejected refresh promise; signal expiry once per failure.
  let lastSignalled: unknown = null;

  http.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config = error.config;
    if (error.response?.status !== 401 || !config || config._retried || isPublicPath(config.url)) {
      throw error;
    }
    const sent = sentWith.get(config);
    // The session changed while the request was in flight: never replay it as another account.
    if (sent && sent.epoch !== deps.getSessionEpoch()) throw error;

    const retry = retryConfig(config);
    const epoch = deps.getSessionEpoch();

    // Another request already rotated the token while this one was in flight.
    const current = deps.getAccessToken();
    if (current && current !== sent?.token) {
      return http.request(authorize(retry, current, epoch));
    }

    let fresh: string;
    try {
      fresh = await deps.refresher.refresh();
    } catch (refreshError: unknown) {
      if (refreshError instanceof SessionExpiredError && refreshError !== lastSignalled) {
        lastSignalled = refreshError;
        deps.onSessionExpired();
      }
      throw error;
    }
    if (deps.getSessionEpoch() !== epoch) throw error;
    return http.request(authorize(retry, fresh, epoch));
  });

  attachErrorSanitizer(http);
  return http;
}
