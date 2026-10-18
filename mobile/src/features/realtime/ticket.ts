import { z } from 'zod';

import type { TicketFailure } from '@/features/realtime/lifecycle';

// POST /ws/ticket (ARCHITECTURE 12): the JWT is traded for a one-time, 30 s ticket, so the access
// token never appears in a WebSocket URL (proxy logs keep URLs for months). One ticket per
// connection - it is never cached or reused. Errors never carry the ticket or the response.

const TICKET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const ticketSchema = z.object({ ticket: z.string().regex(TICKET_PATTERN) });
const MIN_RETRY_AFTER_MS = 1000;
const MAX_RETRY_AFTER_MS = 300_000;

export class TicketError extends Error {
  readonly failure: TicketFailure;
  readonly retryAfterMs?: number;

  constructor(failure: TicketFailure, retryAfterMs?: number) {
    super(`WebSocket ticket request failed (${failure})`);
    this.name = 'TicketError';
    this.failure = failure;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export interface TicketClient {
  post: (url: string, body?: unknown) => Promise<{ data: unknown }>;
}

function headerValue(headers: unknown, name: string): string | null {
  if (typeof headers !== 'object' || headers === null) return null;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value: unknown = getter.call(headers, name);
    if (typeof value === 'string') return value;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return null;
}

function retryAfterMs(headers: unknown): number | undefined {
  const raw = headerValue(headers, 'retry-after');
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Number(raw) * 1000));
}

export function classifyTicketError(error: unknown): { failure: TicketFailure; retryAfterMs?: number } {
  if (error instanceof TicketError) {
    return error.retryAfterMs === undefined
      ? { failure: error.failure }
      : { failure: error.failure, retryAfterMs: error.retryAfterMs };
  }
  const response = (error as { response?: { status?: unknown; headers?: unknown } } | null)?.response;
  const status = typeof response?.status === 'number' ? response.status : null;
  if (status === 401 || status === 403) return { failure: 'auth' };
  if (status === 429) {
    const wait = retryAfterMs(response?.headers);
    return wait === undefined ? { failure: 'rate_limited' } : { failure: 'rate_limited', retryAfterMs: wait };
  }
  return { failure: 'other' };
}

/** A new one-time ticket, or a TicketError saying whether to stop, wait or retry. */
export async function fetchTicket(client: TicketClient): Promise<string> {
  let data: unknown;
  try {
    ({ data } = await client.post('/ws/ticket'));
  } catch (error: unknown) {
    const { failure, retryAfterMs: wait } = classifyTicketError(error);
    throw new TicketError(failure, wait);
  }
  const parsed = ticketSchema.safeParse(data);
  if (!parsed.success) throw new TicketError('other');
  return parsed.data.ticket;
}

/** `<ws base>/availability/?ticket=<ticket>` (the base comes from `extra.wsUrl`, no trailing slash). */
export function socketUrl(wsBaseUrl: string, ticket: string): string {
  return `${wsBaseUrl.replace(/\/+$/, '')}/availability/?ticket=${encodeURIComponent(ticket)}`;
}
