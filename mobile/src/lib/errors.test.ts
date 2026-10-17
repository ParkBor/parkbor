import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import { errorMessageKey, isRevocationRefusal, isSessionRejection, parseApiError } from '@/lib/errors';

function httpError(status: number, data: unknown): AxiosError {
  const response = { status, data, statusText: '', headers: {}, config: {} } as AxiosResponse;
  return new AxiosError('failed', String(status), undefined, {}, response);
}

describe('parseApiError', () => {
  it('reads detail and code from the backend envelope', () => {
    const info = parseApiError(httpError(400, { detail: 'Invalid code.', code: 'invalid_code' }));
    expect(info).toEqual({ kind: 'http', status: 400, code: 'invalid_code', detail: 'Invalid code.' });
  });

  it('classifies a request without response as network', () => {
    const err = new AxiosError('Network Error', 'ERR_NETWORK');
    expect(parseApiError(err).kind).toBe('network');
  });

  it('classifies 429 as throttled', () => {
    expect(parseApiError(httpError(429, {})).kind).toBe('throttled');
  });

  it('tolerates non-object bodies (HTML error pages)', () => {
    const info = parseApiError(httpError(502, '<html>bad gateway</html>'));
    expect(info).toEqual({ kind: 'http', status: 502 });
  });

  it('classifies non-axios errors as unknown', () => {
    expect(parseApiError(new Error('boom')).kind).toBe('unknown');
    expect(parseApiError(null).kind).toBe('unknown');
    expect(parseApiError(undefined).kind).toBe('unknown');
  });
});

describe('errorMessageKey', () => {
  it.each([
    [{ kind: 'network' }, 'errors.network'],
    [{ kind: 'throttled', status: 429 }, 'errors.throttled'],
    [{ kind: 'http', status: 400, code: 'invalid_code' }, 'errors.invalidCode'],
    [{ kind: 'http', status: 410, code: 'login_expired' }, 'errors.codeExpired'],
    [{ kind: 'http', status: 410 }, 'errors.codeExpired'],
    [{ kind: 'http', status: 409, code: 'login_not_confirmed' }, 'errors.notConfirmed'],
    [{ kind: 'http', status: 403, code: 'account_disabled' }, 'errors.accountDisabled'],
    [{ kind: 'http', status: 503 }, 'errors.server'],
    [{ kind: 'http', status: 400 }, 'errors.generic'],
    [{ kind: 'unknown' }, 'errors.generic'],
  ] as const)('maps %j to %s', (info, key) => {
    expect(errorMessageKey(info)).toBe(key);
  });
});

describe('isSessionRejection', () => {
  it.each([
    [401, 'token_not_valid'],
    [400, 'invalid_token'],
    [403, 'account_disabled'],
    [401, 'no_active_account'],
    [401, 'user_inactive'],
    [401, 'user_not_found'],
  ])('accepts %i %s', (status, code) => {
    expect(isSessionRejection(httpError(status, { detail: 'x', code }))).toBe(true);
  });

  it.each([
    [401, {}],
    [403, {}],
    [403, '<html>WAF</html>'],
    [400, {}],
    [400, { detail: 'x', code: 'validation_error' }],
    [401, { detail: 'x', code: 'invalid_token' }],
    [403, { detail: 'x', code: 'user_inactive' }],
    [500, { detail: 'x', code: 'no_active_account' }],
    [404, {}],
    [408, {}],
    [410, {}],
    [429, {}],
    [500, {}],
    [503, { detail: 'x', code: 'token_not_valid' }],
  ])('does not treat %i %j as a verdict on the session', (status, body) => {
    expect(isSessionRejection(httpError(status, body))).toBe(false);
  });

  it('ignores network and non-axios errors', () => {
    expect(isSessionRejection(new AxiosError('Network Error', 'ERR_NETWORK'))).toBe(false);
    expect(isSessionRejection(new Error('x'))).toBe(false);
  });
});

describe('isRevocationRefusal', () => {
  it('is true only for 400 invalid_token', () => {
    expect(isRevocationRefusal(httpError(400, { detail: 'x', code: 'invalid_token' }))).toBe(true);
    expect(isRevocationRefusal(httpError(401, { detail: 'x', code: 'token_not_valid' }))).toBe(false);
    expect(isRevocationRefusal(httpError(400, {}))).toBe(false);
    expect(isRevocationRefusal(httpError(403, {}))).toBe(false);
    expect(isRevocationRefusal(new AxiosError('Network Error', 'ERR_NETWORK'))).toBe(false);
  });
});
