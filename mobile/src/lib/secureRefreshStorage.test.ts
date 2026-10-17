import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as SecureStore from 'expo-secure-store';
import {
  secureOptions,
  securePendingClearStorage,
  securePendingRevokeStore,
  secureRefreshStorage,
} from '@/lib/secureRefreshStorage';

const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));



beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('secureRefreshStorage', () => {
  it('round-trips a token and clears it', async () => {
    expect(await secureRefreshStorage.get()).toBeNull();
    await secureRefreshStorage.set('refresh-1');
    expect(await secureRefreshStorage.get()).toBe('refresh-1');
    await secureRefreshStorage.clear();
    expect(await secureRefreshStorage.get()).toBeNull();
  });

  it('writes with device-only, unlocked-only keychain accessibility', async () => {
    await secureRefreshStorage.set('refresh-1');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      expect.any(String),
      'refresh-1',
      expect.objectContaining({ keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }),
    );
    expect(secureOptions.keychainAccessible).toBe('WHEN_UNLOCKED_THIS_DEVICE_ONLY');
  });

  it('keeps the pending-revoke list separate from the refresh slot and round-trips it', async () => {
    await secureRefreshStorage.set('refresh-1');
    await securePendingRevokeStore.write([{ token: 'queued', userId: 3 }]);
    expect(await secureRefreshStorage.get()).toBe('refresh-1');
    expect(await securePendingRevokeStore.read()).toEqual([{ token: 'queued', userId: 3 }]);
    await securePendingRevokeStore.write([]);
    expect(await securePendingRevokeStore.read()).toEqual([]);
    expect(await secureRefreshStorage.get()).toBe('refresh-1');
  });

  it('tolerates corrupt pending data', async () => {
    store.set('habi.pending_revoke', 'garbage{');
    expect(await securePendingRevokeStore.read()).toEqual([]);
  });

  it('has its own slot for the pending-clear marker', async () => {
    await securePendingClearStorage.set('1');
    expect(await securePendingClearStorage.get()).toBe('1');
    expect(await secureRefreshStorage.get()).toBeNull();
  });
});
