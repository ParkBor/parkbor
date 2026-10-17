import { InvalidResponseError } from '@/features/map/schemas';
import { parseApiError } from '@/lib/errors';

export type MapErrorKind = 'offline' | 'badRequest' | 'throttled' | 'server' | 'invalidResponse' | 'generic';

const MAX_RETRIES = 2;

/**
 * Only transient failures are retried: no network, or a 5xx. Retrying 429 worsens the throttle;
 * 400/403/404 and contract violations cannot be fixed by asking again.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  const kind = mapErrorKey(error);
  return kind === 'offline' || kind === 'server';
}

/** UI category for a failed nearby search. Never exposes backend `detail` text. */
export function mapErrorKey(error: unknown): MapErrorKind {
  if (error instanceof InvalidResponseError) return 'invalidResponse';
  const info = parseApiError(error);
  if (info.kind === 'network') return 'offline';
  if (info.kind === 'throttled') return 'throttled';
  if (info.status === 400) return 'badRequest';
  if (info.status !== undefined && info.status >= 500) return 'server';
  return 'generic';
}
