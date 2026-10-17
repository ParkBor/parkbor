import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as SecureStore from 'expo-secure-store';
import { getDeviceId } from '@/lib/deviceId';

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
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn(() => '11111111-2222-3333-4444-555555555555') }));



beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('getDeviceId', () => {
  it('creates and persists an id on first use, with device-only accessibility', async () => {
    const id = await getDeviceId();
    expect(id).toBe('11111111-2222-3333-4444-555555555555');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      expect.any(String),
      id,
      expect.objectContaining({ keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' }),
    );
  });

  it('returns the same id afterwards without writing again', async () => {
    const first = await getDeviceId();
    vi.mocked(SecureStore.setItemAsync).mockClear();
    expect(await getDeviceId()).toBe(first);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('parallel first calls share one id and one write', async () => {
    const crypto = await import('expo-crypto');
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('aaaaaaaa-0000-0000-0000-000000000001')
      .mockReturnValueOnce('bbbbbbbb-0000-0000-0000-000000000002');
    const ids = await Promise.all([getDeviceId(), getDeviceId(), getDeviceId()]);
    expect(new Set(ids).size).toBe(1);
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed first attempt instead of caching the failure', async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keystore busy'));
    await expect(getDeviceId()).rejects.toThrow('keystore busy');
    await expect(getDeviceId()).resolves.toBeTypeOf('string');
  });

  it('keeps the id within the backend limit (128 chars)', async () => {
    expect((await getDeviceId()).length).toBeLessThanOrEqual(128);
  });
});
