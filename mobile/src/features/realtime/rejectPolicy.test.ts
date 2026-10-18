import { describe, expect, it } from 'vitest';

import { MAX_REJECT_RETRIES, REJECT_RETRY_MS, rejectAction } from '@/features/realtime/rejectPolicy';

describe('rejectAction', () => {
  it('retries not_found once, after the server negative cache expired', () => {
    expect(rejectAction('not_found', 0)).toEqual({ type: 'retry', afterMs: REJECT_RETRY_MS });
    expect(REJECT_RETRY_MS).toBeGreaterThan(30_000);
  });

  it('then gives up', () => {
    expect(rejectAction('not_found', MAX_REJECT_RETRIES)).toEqual({ type: 'give_up' });
  });

  it.each(['invalid_kind', 'invalid_group', 'too_many_groups', 'something_new', ''])('never retries %s', (code) => {
    expect(rejectAction(code, 0)).toEqual({ type: 'give_up' });
  });
});
