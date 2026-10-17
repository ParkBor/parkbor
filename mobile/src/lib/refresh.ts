import { isSessionRejection } from '@/lib/errors';
import { withTimeout } from '@/lib/timeout';
import type { TokenLock } from '@/lib/tokenLock';
import type { RefreshResponse } from '@/lib/types';

/** Persistent (secure) storage for the refresh token — the only place it may live. */
export interface RefreshStorage {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** The refresh token is no good (or can no longer be kept): the user must sign in again. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired');
    this.name = 'SessionExpiredError';
  }
}

/** The session changed (logout / new login) while this refresh was in flight; result dropped. */
export class StaleRefreshError extends Error {
  constructor() {
    super('Refresh result discarded: session changed');
    this.name = 'StaleRefreshError';
  }
}

/** The secure store could not be read (broken Keystore / Keychain). */
export class StorageReadError extends Error {
  constructor() {
    super('Secure storage unreadable');
    this.name = 'StorageReadError';
  }
}

const PERSIST_ATTEMPTS = 2;
/** Every secure-store call made while holding the lock is bounded by this. */
export const DEFAULT_STORAGE_TIMEOUT_MS = 5_000;

export interface TokenRefresherDeps {
  storage: RefreshStorage;
  refreshCall: (refreshToken: string) => Promise<RefreshResponse>;
  onAccessToken: (accessToken: string) => void;
  /** Session generation; bumped on login/logout/clear so stale refresh results are dropped. */
  getEpoch: () => number;
  /** The one lock all token-state writes share (see tokenLock.ts). */
  lock: TokenLock;
  /** Upper bound for each secure-store call (a hung Keystore must not hold the lock forever). */
  storageTimeoutMs?: number;
}

export interface TokenRefresher {
  /**
   * Single-flight per epoch: concurrent callers share one network request. With
   * `expectedEpoch`, refuses (StaleRefreshError) if the session already changed.
   */
  refresh(expectedEpoch?: number): Promise<string>;
  /** Resolves once any in-flight refresh finished (successfully or not). */
  settle(): Promise<void>;
}

export function createTokenRefresher(deps: TokenRefresherDeps): TokenRefresher {
  let inFlight: { epoch: number; promise: Promise<string> } | null = null;

  const isStale = (epoch: number): boolean => deps.getEpoch() !== epoch;
  const bounded = <T>(promise: Promise<T>): Promise<T> =>
    withTimeout(promise, deps.storageTimeoutMs ?? DEFAULT_STORAGE_TIMEOUT_MS);

  /** Runs inside the lock. */
  async function persistRotated(token: string, epoch: number): Promise<void> {
    for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt += 1) {
      try {
        await bounded(deps.storage.set(token));
        return;
      } catch {
        // retry; after the last attempt the session is unrecoverable (see below)
      }
    }
    // Do not touch a session that is not ours any more.
    if (isStale(epoch)) throw new StaleRefreshError();
    // The server already rotated: the old refresh token is blacklisted and the new one
    // cannot be stored, so the session cannot survive a restart. Be explicit about it.
    await bounded(deps.storage.clear()).catch(() => undefined);
    throw new SessionExpiredError();
  }

  async function readStored(): Promise<string | null> {
    try {
      return await bounded(deps.storage.get());
    } catch {
      throw new StorageReadError();
    }
  }

  async function dropRejectedToken(epoch: number): Promise<void> {
    await deps.lock.run(async () => {
      if (!isStale(epoch)) await bounded(deps.storage.clear()).catch(() => undefined);
    });
  }

  async function run(epoch: number): Promise<string> {
    const current = await readStored();
    if (isStale(epoch)) throw new StaleRefreshError();
    if (!current) throw new SessionExpiredError();

    let response: RefreshResponse;
    try {
      response = await deps.refreshCall(current);
    } catch (error: unknown) {
      if (isStale(epoch)) throw new StaleRefreshError();
      if (!isSessionRejection(error)) throw error;
      await dropRejectedToken(epoch);
      if (isStale(epoch)) throw new StaleRefreshError();
      throw new SessionExpiredError();
    }

    // Commit under the lock: the epoch is re-checked right before each write, so a late
    // result can never land after a newer sign-in / sign-out.
    return deps.lock.run(async () => {
      if (isStale(epoch)) throw new StaleRefreshError();
      // Rotation: persist the new refresh token before publishing the access token.
      if (response.refresh) await persistRotated(response.refresh, epoch);
      if (isStale(epoch)) throw new StaleRefreshError();
      deps.onAccessToken(response.access);
      return response.access;
    });
  }

  return {
    refresh(expectedEpoch) {
      const epoch = expectedEpoch ?? deps.getEpoch();
      if (isStale(epoch)) return Promise.reject(new StaleRefreshError());
      if (inFlight && inFlight.epoch === epoch) return inFlight.promise;

      const entry = { epoch, promise: Promise.resolve('') };
      entry.promise = run(epoch).finally(() => {
        if (inFlight === entry) inFlight = null;
      });
      inFlight = entry;
      return entry.promise;
    },

    settle() {
      return inFlight ? inFlight.promise.then(noop, noop) : Promise.resolve();
    },
  };
}

function noop(): undefined {
  return undefined;
}
