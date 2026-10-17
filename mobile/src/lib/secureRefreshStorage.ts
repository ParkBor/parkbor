import * as SecureStore from 'expo-secure-store';

import { parsePending, serializePending, type PendingRevokeStore } from '@/lib/pendingRevokes';
import type { RefreshStorage } from '@/lib/refresh';

/** Never synced/backed up to another device; unreadable while the phone is locked. */
export const secureOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export function secureSlot(key: string): RefreshStorage {
  return {
    get: () => SecureStore.getItemAsync(key, secureOptions),
    set: (token) => SecureStore.setItemAsync(key, token, secureOptions),
    clear: () => SecureStore.deleteItemAsync(key, secureOptions),
  };
}

/** The only persistent home of the refresh token (Android Keystore / iOS Keychain). */
export const secureRefreshStorage: RefreshStorage = secureSlot('habi.refresh_token');

/** Marker: deleting the refresh token failed and must be retried before it is trusted again. */
export const securePendingClearStorage: RefreshStorage = secureSlot('habi.pending_clear');

const pendingRevokeSlot = secureSlot('habi.pending_revoke');

/** Refresh tokens whose server-side revocation is still owed (offline logout), bounded list. */
export const securePendingRevokeStore: PendingRevokeStore = {
  read: async () => parsePending(await pendingRevokeSlot.get()),
  write: async (list) => {
    if (list.length === 0) await pendingRevokeSlot.clear();
    else await pendingRevokeSlot.set(serializePending(list));
  },
};
