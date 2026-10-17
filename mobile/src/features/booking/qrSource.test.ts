import { describe, expect, it, vi } from 'vitest';

import { isQrActive, QR_ACTIVATION_LEAD_MS, resolveQr } from '@/features/booking/qrSource';

const NOW = 1_000_000;
const fresh = { token: 'fresh', expiresAtMs: NOW + 60_000 };
const cached = { token: 'cached', expiresAtMs: NOW + 60_000 };
const networkError = Object.assign(new Error('Network'), { isNetwork: true });
const isNetwork = (error: unknown): boolean => (error as { isNetwork?: boolean }).isNetwork === true;

describe('resolveQr', () => {
  it('online: uses the fresh token', async () => {
    const result = await resolveQr({ isOnline: true, nowMs: NOW, loadCached: async () => cached, fetchFresh: async () => fresh, isNetworkError: isNetwork });
    expect(result).toEqual({ ...fresh, isFromDevice: false });
  });

  it('known offline with a valid copy: shows it at once, without waiting for a request timeout', async () => {
    const fetchFresh = vi.fn(async () => fresh);
    const result = await resolveQr({ isOnline: false, nowMs: NOW, loadCached: async () => cached, fetchFresh, isNetworkError: isNetwork });
    expect(result).toEqual({ ...cached, isFromDevice: true });
    expect(fetchFresh).not.toHaveBeenCalled();
  });

  it('known offline without a copy: still tries the network (the flag may be wrong)', async () => {
    const result = await resolveQr({ isOnline: false, nowMs: NOW, loadCached: async () => null, fetchFresh: async () => fresh, isNetworkError: isNetwork });
    expect(result.isFromDevice).toBe(false);
  });

  it('network error: falls back to the copy', async () => {
    const result = await resolveQr({
      isOnline: true,
      nowMs: NOW,
      loadCached: async () => cached,
      fetchFresh: async () => {
        throw networkError;
      },
      isNetworkError: isNetwork,
    });
    expect(result.isFromDevice).toBe(true);
  });

  it('network error and no copy: the error is surfaced', async () => {
    await expect(
      resolveQr({
        isOnline: true,
        nowMs: NOW,
        loadCached: async () => null,
        fetchFresh: async () => {
          throw networkError;
        },
        isNetworkError: isNetwork,
      }),
    ).rejects.toBe(networkError);
  });

  it('a server verdict (409/404) is never masked by a stale copy', async () => {
    const verdict = new Error('409');
    await expect(
      resolveQr({
        isOnline: true,
        nowMs: NOW,
        loadCached: async () => cached,
        fetchFresh: async () => {
          throw verdict;
        },
        isNetworkError: isNetwork,
      }),
    ).rejects.toBe(verdict);
  });

  it('an expired copy (by the clock passed in) is not used', async () => {
    const expired = { token: 'old', expiresAtMs: NOW - 1 };
    await expect(
      resolveQr({
        isOnline: false,
        nowMs: NOW,
        loadCached: async () => expired,
        fetchFresh: async () => {
          throw networkError;
        },
        isNetworkError: isNetwork,
      }),
    ).rejects.toBe(networkError);
  });
});

describe('isQrActive', () => {
  const START = 10 * 3_600_000;

  it('activates 2 hours before the start', () => {
    expect(QR_ACTIVATION_LEAD_MS).toBe(2 * 3_600_000);
    expect(isQrActive(START, START - QR_ACTIVATION_LEAD_MS - 1)).toBe(false);
    expect(isQrActive(START, START - QR_ACTIVATION_LEAD_MS)).toBe(true);
    expect(isQrActive(START, START + 3_600_000)).toBe(true);
  });
});
