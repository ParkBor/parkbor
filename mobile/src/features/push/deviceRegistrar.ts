import type { PermissionState } from '@/features/push/permissionPolicy';

// Registers this phone's Expo push token with the backend (POST /me/devices) and tells the rest of
// the app which token the device holds right now, so a logout (or a forced wipe) can unregister
// exactly this device. All platform access is injected; the module has no React Native imports.

/** Same shape as the backend EXPO_TOKEN_VALIDATOR, and its 200 character limit. */
const EXPO_TOKEN = /^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/;
const MAX_TOKEN_LENGTH = 200;
/** Foreground returns re-check at most this often. */
export const SYNC_THROTTLE_MS = 60_000;
/** A failed registration is retried while the session lives: after 5 s, 30 s, 2 min, then left to the next trigger. */
export const RETRY_DELAYS_MS: readonly number[] = [5000, 30_000, 120_000];

export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TOKEN_LENGTH && EXPO_TOKEN.test(value);
}

export type SyncResult = 'registered' | 'unchanged' | 'no_session' | 'no_permission' | 'no_token' | 'failed' | 'throttled';

export interface RegistrarDeps {
  platform: 'ios' | 'android';
  /** Current OS permission; must NOT prompt. */
  getPermission: () => Promise<PermissionState>;
  /** The Expo push token (may throw: no EAS project id, simulator, no network). */
  getToken: () => Promise<string | null>;
  register: (platform: 'ios' | 'android', token: string) => Promise<void>;
  /** Told whenever the token this device holds (registered OR being registered) changes. */
  onCurrentToken?: (token: string | null) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DeviceRegistrar {
  /** Registers if permitted and not yet registered for this user + token. Never throws. */
  sync: (userKey: string | null) => Promise<SyncResult>;
  /** Same, but skipped when a check ran in the last minute (foreground returns). */
  syncThrottled: (userKey: string | null) => Promise<SyncResult>;
  /** The session is over: forget the registration and cancel retries. */
  endSession: () => void;
  /** The token registered or being registered right now. */
  currentToken: () => string | null;
}

export function createDeviceRegistrar(deps: RegistrarDeps): DeviceRegistrar {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let registered: { userKey: string; token: string } | null = null;
  let inFlightToken: string | null = null;
  let epoch = 0;
  let inFlight: Promise<SyncResult> | null = null;
  let lastCheckedAt: number | null = null;
  let retryCount = 0;
  let retryTimer: unknown = null;

  function current(): string | null {
    return registered?.token ?? inFlightToken;
  }

  function publish(): void {
    deps.onCurrentToken?.(current());
  }

  function cancelRetry(): void {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry(userKey: string, retry: (userKey: string) => Promise<SyncResult>): void {
    const delay = RETRY_DELAYS_MS[retryCount];
    if (delay === undefined || retryTimer !== null) return;
    retryCount += 1;
    const myEpoch = epoch;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (myEpoch === epoch) void retry(userKey);
    }, delay);
  }

  async function run(userKey: string, myEpoch: number): Promise<SyncResult> {
    lastCheckedAt = now();
    if ((await deps.getPermission().catch((): PermissionState => 'denied')) !== 'granted') return 'no_permission';
    const token = await deps.getToken().catch(() => null);
    if (!isExpoPushToken(token)) return 'no_token';
    if (myEpoch !== epoch) return 'no_session';
    if (registered?.userKey === userKey && registered.token === token) return 'unchanged';
    // From here the server may learn this token for the user, even if the answer never arrives:
    // a logout in the meantime must carry it.
    inFlightToken = token;
    publish();
    try {
      await deps.register(deps.platform, token);
    } catch {
      inFlightToken = null;
      if (myEpoch === epoch) publish();
      return 'failed';
    }
    inFlightToken = null;
    if (myEpoch !== epoch) return 'no_session'; // endSession() already cleared the rest
    registered = { userKey, token };
    retryCount = 0;
    publish();
    return 'registered';
  }

  function sync(userKey: string | null): Promise<SyncResult> {
    if (userKey === null) return Promise.resolve('no_session');
    if (inFlight) return inFlight.then(() => sync(userKey));
    const pending = run(userKey, epoch)
      .then((result) => {
        if (result === 'failed') scheduleRetry(userKey, sync);
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = pending;
    return pending;
  }

  return {
    sync,
    syncThrottled(userKey) {
      if (lastCheckedAt !== null && now() - lastCheckedAt < SYNC_THROTTLE_MS && now() >= lastCheckedAt) {
        return Promise.resolve('throttled');
      }
      return sync(userKey);
    },
    endSession() {
      epoch += 1;
      registered = null;
      // inFlightToken stays until its request settles: the logout request that is being built
      // right now (getPushToken is read before the wipe) must still see it.
      lastCheckedAt = null;
      retryCount = 0;
      cancelRetry();
      deps.onCurrentToken?.(null);
    },
    currentToken: current,
  };
}
