import { describe, expect, it, vi } from 'vitest';

import { TicketError, classifyTicketError, fetchTicket, socketUrl } from '@/features/realtime/ticket';

const TICKET = 'abcdefghijklmnopqrstuvwxyz012345';

function httpError(status: number, headers: Record<string, string> = {}) {
  return { isAxiosError: true, response: { status, headers } };
}

describe('fetchTicket', () => {
  it('POSTs /ws/ticket without a body and returns the ticket', async () => {
    const post = vi.fn().mockResolvedValue({ data: { ticket: TICKET, expires_in: 30 } });
    await expect(fetchTicket({ post })).resolves.toBe(TICKET);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe('/ws/ticket');
  });

  it('asks for a fresh ticket on every call (never caches one)', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ data: { ticket: TICKET, expires_in: 30 } })
      .mockResolvedValueOnce({ data: { ticket: `${TICKET}x`, expires_in: 30 } });
    const first = await fetchTicket({ post });
    const second = await fetchTicket({ post });
    expect(first).not.toBe(second);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['no ticket', { expires_in: 30 }],
    ['empty ticket', { ticket: '', expires_in: 30 }],
    ['short ticket', { ticket: 'abc' }],
    ['ticket with URL-breaking characters', { ticket: 'abcdefghijklmnopqrst&uvwxyz=1' }],
    ['oversized ticket', { ticket: 'a'.repeat(300) }],
    ['non-string ticket', { ticket: 12345678901234567890 }],
    ['not an object', 'ticket'],
  ])('rejects a malformed answer (%s) as a retryable failure', async (_name, data) => {
    const post = vi.fn().mockResolvedValue({ data });
    const error = await fetchTicket({ post }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketError);
    expect((error as TicketError).failure).toBe('other');
  });

  it('the error never carries the ticket or the response', async () => {
    const post = vi.fn().mockResolvedValue({ data: { ticket: 'bad ticket with spaces and more', secret: 'x' } });
    const error = (await fetchTicket({ post }).catch((e: unknown) => e)) as TicketError;
    expect(error.message).not.toContain('bad ticket');
    expect(JSON.stringify(error)).not.toContain('bad ticket');
  });

  it('turns HTTP failures into classified TicketErrors', async () => {
    const post = vi.fn().mockRejectedValue(httpError(429, { 'retry-after': '12' }));
    const error = (await fetchTicket({ post }).catch((e: unknown) => e)) as TicketError;
    expect(error).toBeInstanceOf(TicketError);
    expect(error.failure).toBe('rate_limited');
    expect(error.retryAfterMs).toBe(12_000);
  });
});

describe('classifyTicketError', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [503, 'other'],
    [500, 'other'],
    [400, 'other'],
  ])('HTTP %i -> %s', (status, failure) => {
    expect(classifyTicketError(httpError(status)).failure).toBe(failure);
  });

  it('a network failure (no response) is retryable', () => {
    expect(classifyTicketError({ isAxiosError: true, code: 'ERR_NETWORK' })).toEqual({ failure: 'other' });
    expect(classifyTicketError(new Error('boom'))).toEqual({ failure: 'other' });
    expect(classifyTicketError(null)).toEqual({ failure: 'other' });
  });

  it('keeps a TicketError as it is', () => {
    expect(classifyTicketError(new TicketError('auth'))).toEqual({ failure: 'auth' });
  });

  it('reads Retry-After in seconds and clamps it to 1 s .. 5 min', () => {
    const retry = (value: string) => classifyTicketError(httpError(429, { 'retry-after': value })).retryAfterMs;
    expect(retry('30')).toBe(30_000);
    expect(retry('0')).toBe(1000);
    expect(retry('99999')).toBe(300_000);
    expect(retry('soon')).toBeUndefined();
    expect(retry('-5')).toBeUndefined();
    expect(retry('NaN')).toBeUndefined();
  });

  it('accepts a header object with a differently cased key', () => {
    expect(classifyTicketError(httpError(429, { 'Retry-After': '7' })).retryAfterMs).toBe(7000);
  });
});

describe('socketUrl', () => {
  it('builds <ws>/availability/?ticket=<ticket>', () => {
    expect(socketUrl('wss://api.habi.uz/ws', TICKET)).toBe(`wss://api.habi.uz/ws/availability/?ticket=${TICKET}`);
  });

  it('tolerates a trailing slash in the base URL', () => {
    expect(socketUrl('ws://localhost:8000/ws/', TICKET)).toBe(`ws://localhost:8000/ws/availability/?ticket=${TICKET}`);
  });

  it('encodes the ticket', () => {
    expect(socketUrl('ws://h/ws', 'a b')).toBe('ws://h/ws/availability/?ticket=a%20b');
  });
});
