import * as SecureStore from 'expo-secure-store';

import { createQrCache, type KeyValueStore } from '@/features/booking/qrCache';
import { secureOptions } from '@/lib/secureRefreshStorage';

/**
 * Keystore / Keychain backed storage, same options as the refresh token: not synced, not backed
 * up, readable only while the device is unlocked (WHEN_UNLOCKED_THIS_DEVICE_ONLY).
 * Thin OS wrapper, exercised through the qrCache tests with an in-memory store.
 */
const secureKeyValueStore: KeyValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key, secureOptions),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, secureOptions),
  removeItem: (key) => SecureStore.deleteItemAsync(key, secureOptions),
};

// Storage errors are deliberately not logged: a message could carry the token. The cache is
// best-effort - without it the QR is simply not available offline.
export const qrCache = createQrCache(secureKeyValueStore, () => Date.now());
