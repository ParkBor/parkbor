import { isCancel } from 'axios';

import { InvalidRouteResponseError } from '@/features/route/routeSchemas';
import { parseApiError } from '@/lib/errors';

export type RouteErrorKind =
  | 'offline'
  | 'throttled'
  | 'tooFar'
  | 'badRequest'
  | 'notFound'
  | 'unavailable'
  | 'server'
  | 'unauthorized'
  | 'invalidResponse'
  | 'generic';

export type RouteErrorTextKey = `route.error.${RouteErrorKind}`;

/** i18n key for a failed route request (every kind has its own message, incl. route_too_far). */
export function routeErrorTextKey(kind: RouteErrorKind): RouteErrorTextKey {
  return `route.error.${kind}`;
}

const MAX_RETRIES = 2;

/** UI category of a failed /routes call. Never exposes backend `detail` text or coordinates. */
export function routeErrorKind(error: unknown): RouteErrorKind {
  if (error instanceof InvalidRouteResponseError) return 'invalidResponse';
  if (isCancel(error)) return 'generic';
  const info = parseApiError(error);
  if (info.kind === 'network') return 'offline';
  if (info.kind === 'throttled') return 'throttled';
  if (info.status === 400) return info.code === 'route_too_far' ? 'tooFar' : 'badRequest';
  if (info.status === 404) return 'notFound';
  if (info.status === 401) return 'unauthorized';
  if (info.status === 503) return 'unavailable';
  if (info.status !== undefined && info.status >= 500) return 'server';
  return 'generic';
}

/**
 * Only transient failures are retried: no network or 5xx (503 included). 429 would worsen the
 * throttle; 400/404/401 and contract violations cannot be fixed by asking again.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  const kind = routeErrorKind(error);
  return kind === 'offline' || kind === 'server' || kind === 'unavailable';
}
