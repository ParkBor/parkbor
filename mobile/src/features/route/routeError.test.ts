import { AxiosError, AxiosHeaders, CanceledError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it } from 'vitest';

import { routeErrorKind, routeErrorTextKey, shouldRetry } from '@/features/route/routeError';
import { InvalidRouteResponseError } from '@/features/route/routeSchemas';
import en from '@/i18n/en.json';
import ru from '@/i18n/ru.json';
import uz from '@/i18n/uz.json';

function httpError(status: number, data: unknown = {}): AxiosError {
  const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
  const response = { status, data, statusText: '', headers: {}, config } as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_RESPONSE', config, undefined, response);
}
const offline = () => new AxiosError('Network Error', 'ERR_NETWORK');

describe('routeErrorKind', () => {
  it.each([
    [offline(), 'offline'],
    [httpError(429), 'throttled'],
    [httpError(400, { code: 'route_too_far', detail: 'x' }), 'tooFar'],
    [httpError(400, { code: 'validation_error' }), 'badRequest'],
    [httpError(400), 'badRequest'],
    [httpError(404, { code: 'route_not_found' }), 'notFound'],
    [httpError(503, { code: 'routing_unavailable' }), 'unavailable'],
    [httpError(500), 'server'],
    [httpError(401), 'unauthorized'],
    [httpError(418), 'generic'],
    [new InvalidRouteResponseError(), 'invalidResponse'],
    [new CanceledError(), 'generic'],
    [new Error('x'), 'generic'],
  ])('classifies case %#', (error, kind) => {
    expect(routeErrorKind(error)).toBe(kind);
  });
});

describe('routeErrorTextKey', () => {
  it('has a catalog entry in every language for every error kind (incl. route_too_far)', () => {
    const kinds = [
      'offline', 'throttled', 'tooFar', 'badRequest', 'notFound',
      'unavailable', 'server', 'unauthorized', 'invalidResponse', 'generic',
    ] as const;
    for (const catalog of [uz, ru, en]) {
      for (const kind of kinds) {
        const key = routeErrorTextKey(kind);
        expect(key).toBe(`route.error.${kind}`);
        expect((catalog.route.error as Record<string, string>)[kind]?.length, `${kind}`).toBeGreaterThan(5);
      }
    }
  });
});

describe('shouldRetry', () => {
  it('retries offline and 5xx (including 503) at most twice', () => {
    expect(shouldRetry(0, offline())).toBe(true);
    expect(shouldRetry(1, httpError(502))).toBe(true);
    expect(shouldRetry(0, httpError(503, { code: 'routing_unavailable' }))).toBe(true);
    expect(shouldRetry(2, httpError(500))).toBe(false);
  });

  it.each([
    ['429', httpError(429)],
    ['400', httpError(400)],
    ['route_too_far', httpError(400, { code: 'route_too_far' })],
    ['404', httpError(404)],
    ['401', httpError(401)],
    ['invalid response', new InvalidRouteResponseError()],
    ['cancel', new CanceledError()],
  ])('never retries %s', (_label, error) => {
    expect(shouldRetry(0, error)).toBe(false);
  });
});
