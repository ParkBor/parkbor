import { createStore, type StoreApi } from 'zustand/vanilla';

import { isRevocationRefusal, isSessionRejection } from '@/lib/errors';
import {
  addPending,
  removePending,
  type PendingRevoke,
  type PendingRevokeStore,
} from '@/lib/pendingRevokes';
import {
  createTokenRefresher,
  DEFAULT_STORAGE_TIMEOUT_MS,
  SessionExpiredError,
  StaleRefreshError,
  StorageReadError,
  type RefreshStorage,
} from '@/lib/refresh';
import { withTimeout } from '@/lib/timeout';
import { createTokenLock } from '@/lib/tokenLock';
import type { RefreshResponse, User } from '@/lib/types';

/** `offline`: a stored session exists but could not be verified (network/5xx/429/timeout). */
export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'offline';

/** Refresh tokens are deliberately NOT part of this state (secure-store only). */
export interface AuthState {
  user: User | null;
  accessToken: string | null;
  status: AuthStatus;
  /** (Re)verifies the stored session; also the "try again" action from `offline`. */
  bootstrap: () => Promise<void>;
  /** From `offline`: queue the stored token for revocation, clear it, continue to sign-in. */
  leaveOffline: () => Promise<void>;
  setSession: (session: { access: string; refresh: string; user: User }) => Promise<void>;
  /**
   * Replaces the signed-in user (e.g. after PATCH /me). `forEpoch` is the session epoch when the
   * request STARTED; a response from an earlier session is ignored.
   */
  setUser: (user: User, forEpoch: number) => Promise<void>;
  refreshAccess: () => Promise<string>;
  /** Local state is cleared immediately; server revocation continues in the background. Never rejects. */
  logout: () => Promise<void>;
  /** Local-only teardown (refresh rejected / forced sign out). Never rejects. */
  clearSession: () => Promise<void>;
  /** Session generation; changes whenever the session is replaced or destroyed. */
  getEpoch: () => number;
}

export interface AuthStoreDeps {
  storage: RefreshStorage;
  /** Marker: a `storage.clear()` failed and must be retried before the stored token is trusted. */
  pendingClear: RefreshStorage;
  /** Refresh tokens whose server-side revocation is still owed. */
  pendingRevoke: PendingRevokeStore;
  refreshCall: (refreshToken: string) => Promise<RefreshResponse>;
  fetchMe: (accessToken: string) => Promise<User>;
  /** `pushToken` (when this device had one) lets the server unregister it together with the logout. */
  serverLogout: (refreshToken: string, accessToken: string, pushToken?: string) => Promise<void>;
  /** This device's Expo push token right now (registered or being registered), if any. */
  getPushToken?: () => string | null;
  /** Security-relevant events only; never receives token material. */
  logger?: { warn: (message: string) => void };
  bootstrapTimeoutMs?: number;
  storageTimeoutMs?: number;
  settleTimeoutMs?: number;
  maxStorageFailures?: number;
}

/** >= the HTTP request timeout, so a slow-but-alive refresh is not abandoned by the UI timer. */
export const BOOTSTRAP_TIMEOUT_MS = 20_000;
export const SETTLE_TIMEOUT_MS = 2_000;
export const MAX_STORAGE_FAILURES = 3;

const ANONYMOUS = { user: null, accessToken: null, status: 'anonymous' } as const;
const OFFLINE = { user: null, accessToken: null, status: 'offline' } as const;

function noop(): undefined {
  return undefined;
}

export function createAuthStore(deps: AuthStoreDeps): StoreApi<AuthState> {
  const bootstrapTimeout = deps.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS;
  const storageTimeout = deps.storageTimeoutMs ?? DEFAULT_STORAGE_TIMEOUT_MS;
  const settleTimeout = deps.settleTimeoutMs ?? SETTLE_TIMEOUT_MS;
  const maxStorageFailures = deps.maxStorageFailures ?? MAX_STORAGE_FAILURES;
  const logger = deps.logger ?? { warn: (message: string) => console.warn(message) };

  /** Session generation: bumped whenever the session is replaced or destroyed. */
  let epoch = 0;
  /** Latest unconditional mutation request; an older queued one is superseded by a newer one. */
  let latestTicket = 0;
  /** The single lock for every write to token state (storage, state, pending revocations). */
  const lock = createTokenLock();
  let storageFailures = 0;
  let booting: Promise<void> | null = null;
  let isFlushing = false;

  /** Every secure-store call under the lock is bounded: a hung Keystore must not wedge sign-out. */
  const bounded = <T>(promise: Promise<T>): Promise<T> => withTimeout(promise, storageTimeout);

  return createStore<AuthState>()((set, get) => {
    const refresher = createTokenRefresher({
      storage: deps.storage,
      refreshCall: deps.refreshCall,
      onAccessToken: (accessToken) => set({ accessToken }),
      getEpoch: () => epoch,
      lock,
      storageTimeoutMs: storageTimeout,
    });

    /** Unconditional mutation: supersedes everything older; a newer one supersedes this one. */
    function mutate<T>(work: () => Promise<T>): Promise<T | undefined> {
      epoch += 1; // cancels results of anything in flight right away
      latestTicket += 1;
      const ticket = latestTicket;
      return lock.run(async () => (ticket === latestTicket ? work() : undefined));
    }

    /** Mutation that only happens if the session is still the one the caller looked at. */
    function mutateIfCurrent(expected: number, work: () => Promise<void>): Promise<void> {
      return lock.run(async () => {
        if (epoch !== expected) return;
        epoch += 1;
        await work();
      });
    }

    /** Runs inside the lock. Never throws, never hangs. */
    async function wipeLocal(): Promise<void> {
      await queuePushRevoke();
      try {
        await bounded(deps.storage.clear());
        await bounded(deps.pendingClear.clear()).catch(noop);
      } catch {
        // Could not delete the token: remember to retry before it is ever trusted again.
        await bounded(deps.pendingClear.set('1')).catch(noop);
      } finally {
        set(ANONYMOUS);
      }
    }

    /**
     * Every wipe (forced ones too: expiry, unreadable storage) that loses a refresh token while this
     * device has a push token queues a revocation carrying it, so the device is not left behind.
     */
    async function queuePushRevoke(): Promise<void> {
      const pushToken = deps.getPushToken?.() ?? null;
      if (!pushToken) return;
      try {
        const token = await bounded(deps.storage.get());
        if (token) await addPendingUnlocked({ token, userId: get().user?.id ?? null, pushToken });
      } catch {
        // best effort: the wipe itself must go on
      }
    }

    async function addPendingUnlocked(entry: PendingRevoke): Promise<void> {
      const list = await bounded(deps.pendingRevoke.read());
      const next = addPending(list, entry, (dropped) =>
        logger.warn(`[auth] revocation queue full: dropped ${dropped} oldest entr${dropped === 1 ? 'y' : 'ies'}`),
      );
      await bounded(deps.pendingRevoke.write(next));
    }

    function dequeue(token: string): Promise<void> {
      return lock
        .run(async () => {
          const list = await bounded(deps.pendingRevoke.read());
          await bounded(deps.pendingRevoke.write(removePending(list, token)));
        })
        .catch(noop);
    }

    /** Tries one revocation. Keeps the entry queued unless the server gave a definitive answer. */
    async function revoke(entry: PendingRevoke, accessToken: string): Promise<void> {
      try {
        if (entry.pushToken) await deps.serverLogout(entry.token, accessToken, entry.pushToken);
        else await deps.serverLogout(entry.token, accessToken);
        await dequeue(entry.token);
      } catch (error: unknown) {
        // Network, 5xx and an expired access token (401) say nothing about the old refresh
        // token, so those stay queued for the next sign-in.
        if (isRevocationRefusal(error)) await dequeue(entry.token);
      }
    }

    async function flushPendingRevokes(): Promise<void> {
      const { status, accessToken, user } = get();
      if (isFlushing || status !== 'authenticated' || !accessToken || !user) return;
      isFlushing = true;
      try {
        for (const entry of await bounded(deps.pendingRevoke.read())) {
          if (entry.userId !== null && String(entry.userId) !== String(user.id)) {
            await dequeue(entry.token); // another account's token: we cannot revoke it
          } else {
            await revoke(entry, accessToken);
          }
        }
      } catch {
        // Best effort and invisible to the user; retried after the next sign-in.
      } finally {
        isFlushing = false;
      }
    }

    /** Applies a verification result only if no sign-in / sign-out happened meanwhile. */
    function publish(startedAt: number, state: Partial<AuthState>): Promise<void> {
      return lock.run(async () => {
        if (epoch === startedAt) set(state);
      });
    }

    async function handleStorageFailure(startedAt: number): Promise<void> {
      storageFailures += 1;
      if (storageFailures >= maxStorageFailures) {
        storageFailures = 0;
        await mutateIfCurrent(startedAt, wipeLocal); // delete the unreadable item, start fresh
        return;
      }
      await publish(startedAt, OFFLINE);
    }

    async function verifyStoredSession(): Promise<void> {
      const startedAt = epoch;

      const owesClear = await bounded(deps.pendingClear.get()).catch(() => null);
      if (owesClear) {
        await mutateIfCurrent(startedAt, wipeLocal); // finish the interrupted sign-out first
        return;
      }

      let stored: string | null;
      try {
        stored = await bounded(deps.storage.get());
      } catch {
        await handleStorageFailure(startedAt);
        return;
      }
      storageFailures = 0;
      if (!stored) {
        await publish(startedAt, ANONYMOUS);
        return;
      }

      try {
        // Bound to the epoch we started in: never rotates a token of a newer session.
        const access = await refresher.refresh(startedAt);
        const user = await deps.fetchMe(access);
        await publish(startedAt, { user, accessToken: access, status: 'authenticated' });
        if (epoch === startedAt) void flushPendingRevokes();
      } catch (error: unknown) {
        if (error instanceof StaleRefreshError) return;
        if (error instanceof StorageReadError) return handleStorageFailure(startedAt);
        if (error instanceof SessionExpiredError) return publish(startedAt, ANONYMOUS);
        if (isSessionRejection(error)) return mutateIfCurrent(startedAt, wipeLocal);
        // Transient (network, 5xx, 429, proxy answers): keep the stored token, let the user retry.
        return publish(startedAt, OFFLINE);
      }
    }

    return {
      user: null,
      accessToken: null,
      status: 'loading',

      getEpoch: () => epoch,
      refreshAccess: () => refresher.refresh(),

      async bootstrap() {
        const startedAt = epoch;
        set({ status: 'loading' });
        // Single-flight: a retry joins the attempt in progress instead of starting a second
        // refresh with the same (possibly already rotated) token.
        booting ??= verifyStoredSession()
          .catch(noop)
          .finally(() => {
            booting = null;
          });
        const attempt = booting;

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), bootstrapTimeout);
        });
        const outcome = await Promise.race([attempt, timeout]);
        clearTimeout(timer);

        // The UI must not wait forever. The attempt keeps running and, if the session did
        // not change meanwhile, still publishes its result (so a rotated token is never lost).
        if (outcome === 'timeout' && epoch === startedAt && get().status === 'loading') set(OFFLINE);
      },

      async leaveOffline() {
        if (get().status !== 'offline') return;
        // Checked INSIDE the lock, before the epoch moves: if anything resolved the status
        // meanwhile, nothing happens at all.
        await lock.run(async () => {
          if (get().status !== 'offline') return;
          epoch += 1;
          try {
            const token = await bounded(deps.storage.get());
            if (token) await addPendingUnlocked({ token, userId: null });
          } catch {
            // nothing more we can do; the token is deleted below regardless
          }
          await wipeLocal();
        });
      },

      async setSession({ access, refresh, user }) {
        await mutate(async () => {
          try {
            await bounded(deps.storage.set(refresh));
          } catch (error: unknown) {
            set(ANONYMOUS);
            throw error;
          }
          // a stale "clear" marker must not hit the new session
          await bounded(deps.pendingClear.clear()).catch(noop);
          set({ user, accessToken: access, status: 'authenticated' });
        });
        if (get().status === 'authenticated') void flushPendingRevokes();
      },

      async setUser(user, forEpoch) {
        await lock.run(async () => {
          if (epoch === forEpoch && get().status === 'authenticated') set({ user });
        });
      },

      async clearSession() {
        try {
          await mutate(wipeLocal);
        } catch {
          // wipeLocal never throws; this only guards the lock plumbing.
        }
      },

      async logout() {
        let entry: PendingRevoke | null = null;
        let access: string | null = null;
        try {
          // So we revoke the CURRENT token, not a stale one - but never let a hung refresh
          // delay sign-out: the wait is bounded.
          await withTimeout(refresher.settle(), settleTimeout).catch(noop);
          access = get().accessToken;
          const token = await bounded(deps.storage.get());
          if (token) {
            const pushToken = deps.getPushToken?.() ?? null;
            entry = { token, userId: get().user?.id ?? null, ...(pushToken ? { pushToken } : {}) };
            const queued = entry;
            // Queue BEFORE wiping: if the app dies mid-revoke the obligation survives.
            await lock.run(() => addPendingUnlocked(queued)).catch(noop);
          }
        } catch {
          // never block sign-out
        }
        await get().clearSession();
        if (entry && access) void revoke(entry, access); // background; never awaited
      },
    };
  });
}
