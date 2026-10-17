import { describe, expect, it } from 'vitest';

import { loadState } from '@/lib/loadState';

describe('loadState', () => {
  it('data wins over everything', () => {
    expect(loadState({ hasData: true, isPending: false, isError: true, fetchStatus: 'idle' })).toBe('ready');
    expect(loadState({ hasData: true, isPending: false, isError: false, fetchStatus: 'paused' })).toBe('ready');
  });

  it('first load in progress is loading', () => {
    expect(loadState({ hasData: false, isPending: true, isError: false, fetchStatus: 'fetching' })).toBe('loading');
  });

  it('a paused first load (no connection) is offline, not an endless spinner', () => {
    expect(loadState({ hasData: false, isPending: true, isError: false, fetchStatus: 'paused' })).toBe('offline');
  });

  it('an error without data is error', () => {
    expect(loadState({ hasData: false, isPending: false, isError: true, fetchStatus: 'idle' })).toBe('error');
  });

  it('a disabled query that never ran is loading', () => {
    expect(loadState({ hasData: false, isPending: true, isError: false, fetchStatus: 'idle' })).toBe('loading');
  });
});
