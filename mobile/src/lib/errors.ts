import { isAxiosError } from 'axios';

export type ApiErrorKind = 'network' | 'throttled' | 'http' | 'unknown';

export interface ApiErrorInfo {
  kind: ApiErrorKind;
  status?: number;
  /** Machine code from the backend envelope ({detail, code}). */
  code?: string;
  detail?: string;
}

export type ErrorKey =
  | 'errors.network'
  | 'errors.throttled'
  | 'errors.invalidCode'
  | 'errors.codeExpired'
  | 'errors.notConfirmed'
  | 'errors.accountDisabled'
  | 'errors.roleNotAllowed'
  | 'errors.phoneTaken'
  | 'errors.accountDeletionBlocked'
  | 'errors.server'
  | 'errors.generic';

function readEnvelope(data: unknown): { code?: string; detail?: string } {
  if (typeof data !== 'object' || data === null) return {};
  const record = data as Record<string, unknown>;
  return {
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
  };
}

export function parseApiError(error: unknown): ApiErrorInfo {
  if (!isAxiosError(error)) return { kind: 'unknown' };
  const response = error.response;
  if (!response) return { kind: 'network' };
  const base = { status: response.status, ...readEnvelope(response.data) };
  return { kind: response.status === 429 ? 'throttled' : 'http', ...base };
}

/** i18n key for a user-facing message; never exposes backend `detail` text. */
export function errorMessageKey(info: ApiErrorInfo): ErrorKey {
  if (info.kind === 'network') return 'errors.network';
  if (info.kind === 'throttled') return 'errors.throttled';
  if (info.code === 'invalid_code') return 'errors.invalidCode';
  if (info.code === 'login_expired' || info.status === 410) return 'errors.codeExpired';
  if (info.code === 'login_not_confirmed') return 'errors.notConfirmed';
  if (info.code === 'account_disabled') return 'errors.accountDisabled';
  if (info.code === 'role_not_allowed') return 'errors.roleNotAllowed';
  if (info.code === 'phone_taken') return 'errors.phoneTaken';
  if (info.code === 'account_deletion_blocked') return 'errors.accountDeletionBlocked';
  if (info.status !== undefined && info.status >= 500) return 'errors.server';
  return 'errors.generic';
}

/** Backend codes that mean "this credential is dead", with the status they arrive with. */
const SESSION_REJECTIONS: Readonly<Record<string, number>> = {
  token_not_valid: 401,
  invalid_token: 400,
  account_disabled: 403,
  // simplejwt (not altered by apps.core.exception_handler): inactive / deleted user.
  no_active_account: 401,
  user_inactive: 401,
  user_not_found: 401,
};

/**
 * True only for an explicit backend verdict on the credential. A bare 401/403 (proxy, CDN,
 * WAF), 404, 408, 410, 429, 5xx or a code-less 400 are NOT verdicts and never end a session.
 */
export function isSessionRejection(error: unknown): boolean {
  const { kind, status, code } = parseApiError(error);
  return kind === 'http' && code !== undefined && SESSION_REJECTIONS[code] === status;
}

/** The server says this refresh token cannot be revoked (already invalid / not this user's). */
export function isRevocationRefusal(error: unknown): boolean {
  const { kind, status, code } = parseApiError(error);
  return kind === 'http' && status === 400 && code === 'invalid_token';
}
