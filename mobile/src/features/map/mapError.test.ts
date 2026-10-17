import { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';

import { mapErrorKey, shouldRetry } from '@/features/map/mapError';
import { InvalidResponseError } from '@/features/map/schemas';

function httpError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  const response = { status, data, statusText: '', headers: {}, config } as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_REQUEST', config, undefined, response);
}

describe('shouldRetry', () => {
  it('retries offline and server errors up to twice', () => {
    expect(shouldRetry(0, new AxiosError('Network Error', 'ERR_NETWORK'))).toBe(true);
    expect(shouldRetry(1, httpError(502, {}))).toBe(true);
    expect(shouldRetry(2, httpError(502, {}))).toBe(false);
  });

  it.each([
    ['429 throttle', httpError(429, {})],
    ['400', httpError(400, {})],
    ['403', httpError(403, {})],
    ['404', httpError(404, {})],
    ['invalid response', new InvalidResponseError()],
    ['unknown', new Error('x')],
  ])('never retries %s', (_label, error) => {
    expect(shouldRetry(0, error)).toBe(false);
  });
});

describe('mapErrorKey', () => {
  it('maps a missing response to the offline state', () => {
    expect(mapErrorKey(new AxiosError('Network Error', 'ERR_NETWORK'))).toBe('offline');
  });

  it('maps backend 400 to badRequest without using its detail text', () => {
    expect(mapErrorKey(httpError(400, { detail: 'lat=41.3 invalid', code: 'invalid_params' }))).toBe('badRequest');
  });

  it('maps 429, 5xx, invalid bodies and unknown errors', () => {
    expect(mapErrorKey(httpError(429, {}))).toBe('throttled');
    expect(mapErrorKey(httpError(503, {}))).toBe('server');
    expect(mapErrorKey(new InvalidResponseError())).toBe('invalidResponse');
    expect(mapErrorKey(new Error('x'))).toBe('generic');
    expect(mapErrorKey(httpError(404, {}))).toBe('generic');
  });
});
