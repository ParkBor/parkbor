import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it } from 'vitest';

import { ContractError } from '@/lib/contract';
import { describeFailure, type CodeRules } from '@/lib/failure';

function httpError(status: number, data?: unknown): AxiosError {
  const response = { status, data, headers: {}, statusText: '', config: {} } as unknown as AxiosResponse;
  return new AxiosError('failed', 'ERR_BAD_RESPONSE', undefined, undefined, response);
}

const RULES: CodeRules = {
  no_slot: { retry: 'edit' },
  dead: { retry: 'none' },
};

describe('describeFailure', () => {
  it('maps a known machine code to its own key and policy', () => {
    expect(describeFailure(httpError(409, { code: 'no_slot', detail: 'x' }), RULES, 'p.err')).toEqual({
      key: 'p.err.no_slot',
      retry: 'edit',
      code: 'no_slot',
      status: 409,
    });
  });

  it('treats a missing connection as retryable with the same key', () => {
    const noResponse = new AxiosError('Network Error', 'ERR_NETWORK');
    expect(describeFailure(noResponse, RULES, 'p.err')).toMatchObject({ key: 'failure.network', retry: 'same_key', status: null });
  });

  it('maps throttling, 503, 5xx, 404, 400 and unknown statuses generically', () => {
    const f = (status: number, data?: unknown) => describeFailure(httpError(status, data), RULES, 'p.err');
    expect(f(429)).toMatchObject({ key: 'failure.throttled', retry: 'same_key' });
    expect(f(503)).toMatchObject({ key: 'failure.unavailable', retry: 'same_key' });
    expect(f(500)).toMatchObject({ key: 'failure.server', retry: 'same_key' });
    expect(f(404)).toMatchObject({ key: 'failure.notFound', retry: 'none' });
    expect(f(400)).toMatchObject({ key: 'failure.badRequest', retry: 'edit' });
    expect(f(418)).toMatchObject({ key: 'failure.generic', retry: 'none' });
  });

  it('ignores unknown codes and never leaks backend detail text', () => {
    const result = describeFailure(httpError(409, { code: 'brand_new', detail: 'SELECT * FROM secrets' }), RULES, 'p.err');
    expect(result.key).toBe('failure.generic');
    expect(JSON.stringify(result)).not.toContain('SELECT');
  });

  it('does not take a code from a prototype property', () => {
    expect(describeFailure(httpError(409, { code: 'constructor' }), RULES, 'p.err').key).toBe('failure.generic');
    expect(describeFailure(httpError(409, { code: '__proto__' }), RULES, 'p.err').key).toBe('failure.generic');
  });

  it('flags a contract violation as non-retryable', () => {
    expect(describeFailure(new ContractError('booking'), RULES, 'p.err')).toMatchObject({ key: 'failure.contract', retry: 'none' });
  });

  it('handles non-axios throwables', () => {
    expect(describeFailure('boom', RULES, 'p.err').key).toBe('failure.generic');
    expect(describeFailure(null, RULES, 'p.err').key).toBe('failure.generic');
  });
});
