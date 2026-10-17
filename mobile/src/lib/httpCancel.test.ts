import { CanceledError, isCancel, type AxiosAdapter } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { createHttp } from '@/lib/http';

// Query cancellation (logout, unmount, new search) aborts requests with an AbortSignal. That must
// never look like an expired credential and kick off the refresh flow.
describe('http client and aborted requests', () => {
  it('rethrows CanceledError without refreshing or ending the session', async () => {
    const refresh = vi.fn();
    const onSessionExpired = vi.fn();
    const adapter: AxiosAdapter = () => Promise.reject(new CanceledError('canceled'));
    const http = createHttp({
      baseURL: 'http://api.test',
      getAccessToken: () => 'access',
      getSessionEpoch: () => 1,
      refresher: { refresh },
      onSessionExpired,
      adapter,
    });

    const controller = new AbortController();
    const failure = await http.get('/parkings/nearby', { signal: controller.signal }).catch((e: unknown) => e);

    expect(isCancel(failure)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});
