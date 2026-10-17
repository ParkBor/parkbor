import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { secureOptions } from '@/lib/secureRefreshStorage';

const DEVICE_ID_KEY = 'habi.device_id';

let inFlight: Promise<string> | null = null;

async function loadOrCreate(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY, secureOptions);
  if (existing) return existing;
  const created = Crypto.randomUUID();
  await SecureStore.setItemAsync(DEVICE_ID_KEY, created, secureOptions);
  return created;
}

/**
 * Random per-install id sent to /auth/telegram/start for diagnostics (backend max 128 chars).
 * Concurrent first calls share one attempt, so they cannot generate two different ids.
 */
export function getDeviceId(): Promise<string> {
  inFlight ??= loadOrCreate().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
