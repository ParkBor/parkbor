import { AxiosError, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PendingRevoke, PendingRevokeStore } from '@/lib/pendingRevokes';
import type { RefreshStorage } from '@/lib/refresh';
import type { RefreshResponse, User } from '@/lib/types';
import { createAuthStore, type AuthStoreDeps } from '@/store/createAuthStore';

const USER: User = {
  id: 1,
  telegram_id: 99,
  telegram_username: 'ali',
  phone: '+998901234567',
  first_name: 'Ali',
  last_name: '',
  language: 'uz',
  role: 'DRIVER',
  tg_notifications: true,
};
const USER_B: User = { ...USER, id: 2, first_name: 'Bobur' };

type MemoryStorage = RefreshStorage & { value: string | null };

function memoryStorage(initial: string | null): MemoryStorage {
  const s: MemoryStorage = {
    value: initial,
    get: async () => s.value,
    set: async (t: string) => {
      s.value = t;
    },
    clear: async () => {
      s.value = null;
    },
  };
  return s;
}

function memoryPending(initial: PendingRevoke[] = []): PendingRevokeStore & { list: PendingRevoke[] } {
  const p = {
    list: initial,
    read: async () => [...p.list],
    write: async (l: readonly PendingRevoke[]) => {
      p.list = [...l];
    },
  };
  return p;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function httpError(status: number, code?: string): AxiosError {
  const response = {
    status,
    data: code ? { detail: 'x', code } : {},
    statusText: '',
    headers: {},
    config: {},
  } as AxiosResponse;
  return new AxiosError('failed', String(status), undefined, {}, response);
}

const networkError = () => new AxiosError('Network Error', 'ERR_NETWORK');
const flushMicrotasks = async () => {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
};

function setup(initialRefresh: string | null = 'refresh-1', overrides: Partial<AuthStoreDeps> = {}) {
  const storage = memoryStorage(initialRefresh);
  const pendingClear = memoryStorage(null);
  const pendingRevoke = memoryPending();
  const refreshCall = vi
    .fn<(t: string) => Promise<RefreshResponse>>()
    .mockResolvedValue({ access: 'access-2', refresh: 'refresh-2' });
  const fetchMe = vi.fn<(a: string) => Promise<User>>().mockResolvedValue(USER);
  const serverLogout = vi.fn<(r: string, a: string) => Promise<void>>().mockResolvedValue(undefined);
  const store = createAuthStore({
    storage,
    pendingClear,
    pendingRevoke,
    refreshCall,
    fetchMe,
    serverLogout,
    bootstrapTimeoutMs: 1000,
    storageTimeoutMs: 200,
    maxStorageFailures: 3,
    settleTimeoutMs: 100,
    ...overrides,
  });
  return { store, storage, pendingClear, pendingRevoke, refreshCall, fetchMe, serverLogout };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('auth store', () => {
  it('starts in loading with no user or token', () => {
    const { store } = setup();
    expect(store.getState()).toMatchObject({ status: 'loading', user: null, accessToken: null });
  });

  describe('bootstrap', () => {
    it('becomes anonymous when no refresh token is stored', async () => {
      const { store, refreshCall } = setup(null);
      await store.getState().bootstrap();
      expect(store.getState().status).toBe('anonymous');
      expect(refreshCall).not.toHaveBeenCalled();
    });

    it('refreshes, rotates the stored token and loads the user', async () => {
      const { store, storage, refreshCall, fetchMe } = setup();
      await store.getState().bootstrap();

      expect(refreshCall).toHaveBeenCalledWith('refresh-1');
      expect(fetchMe).toHaveBeenCalledWith('access-2');
      expect(storage.value).toBe('refresh-2');
      expect(store.getState()).toMatchObject({ status: 'authenticated', user: USER, accessToken: 'access-2' });
    });

    it('never puts a refresh token into the zustand state', async () => {
      const { store } = setup();
      await store.getState().bootstrap();
      const snapshot = JSON.stringify(store.getState());
      expect(snapshot).not.toContain('refresh-1');
      expect(snapshot).not.toContain('refresh-2');
    });

    it('goes anonymous and clears storage on an explicit token verdict', async () => {
      const { store, storage, refreshCall } = setup();
      refreshCall.mockRejectedValue(httpError(401, 'token_not_valid'));
      await store.getState().bootstrap();
      expect(store.getState().status).toBe('anonymous');
      expect(storage.value).toBeNull();
    });

    it.each([
      ['network failure', networkError()],
      ['429', httpError(429)],
      ['503', httpError(503)],
      ['code-less 401 (proxy)', httpError(401)],
      ['code-less 403 (WAF/CDN)', httpError(403)],
      ['404', httpError(404)],
      ['408', httpError(408)],
      ['410', httpError(410)],
      ['code-less 400', httpError(400)],
    ])('goes offline (not anonymous) and keeps the refresh token on %s', async (_n, error) => {
      const { store, storage, refreshCall } = setup();
      refreshCall.mockRejectedValue(error);
      await store.getState().bootstrap();
      expect(store.getState().status).toBe('offline');
      expect(store.getState().accessToken).toBeNull();
      expect(storage.value).toBe('refresh-1');
    });

    it('goes offline when /me fails transiently, without authenticating', async () => {
      const { store, fetchMe } = setup();
      fetchMe.mockRejectedValue(networkError());
      await store.getState().bootstrap();
      expect(store.getState().status).toBe('offline');
      expect(store.getState().accessToken).toBeNull();
      expect(store.getState().user).toBeNull();
    });

    it.each([httpError(404), httpError(403), httpError(410)])(
      'does NOT delete the session when /me answers with a non-verdict (%s)',
      async (error) => {
        const { store, storage, fetchMe } = setup();
        fetchMe.mockRejectedValue(error);
        await store.getState().bootstrap();
        expect(store.getState().status).toBe('offline');
        expect(storage.value).toBe('refresh-2'); // rotated, kept
      },
    );

    it('drops the session when /me reports the account disabled (explicit code)', async () => {
      const { store, storage, fetchMe } = setup();
      fetchMe.mockRejectedValue(httpError(403, 'account_disabled'));
      await store.getState().bootstrap();
      expect(store.getState().status).toBe('anonymous');
      expect(storage.value).toBeNull();
    });

    it('can be retried from offline and then authenticates', async () => {
      const { store, refreshCall } = setup();
      refreshCall.mockRejectedValueOnce(networkError());
      await store.getState().bootstrap();
      expect(store.getState().status).toBe('offline');
      await store.getState().bootstrap();
      expect(store.getState().status).toBe('authenticated');
    });
  });

  describe('bootstrap timeout and retry (slow network)', () => {
    it('shows offline at the timeout but still adopts the late result: R2 is saved, the session survives', async () => {
      vi.useFakeTimers();
      const { store, storage, refreshCall } = setup();
      const slow = deferred<RefreshResponse>();
      refreshCall.mockReturnValue(slow.promise);

      const boot = store.getState().bootstrap();
      await vi.advanceTimersByTimeAsync(1001);
      await boot;
      expect(store.getState().status).toBe('offline');

      slow.resolve({ access: 'late-access', refresh: 'R2' }); // server rotated R1 -> R2
      await vi.advanceTimersByTimeAsync(10);

      expect(storage.value).toBe('R2');
      expect(store.getState()).toMatchObject({ status: 'authenticated', accessToken: 'late-access' });
    });

    it('a retry while the first attempt is still running starts NO second refresh', async () => {
      vi.useFakeTimers();
      const { store, storage, refreshCall } = setup();
      const slow = deferred<RefreshResponse>();
      refreshCall.mockReturnValue(slow.promise);

      const first = store.getState().bootstrap();
      await vi.advanceTimersByTimeAsync(1001);
      await first;
      expect(store.getState().status).toBe('offline');

      const retry = store.getState().bootstrap();
      expect(store.getState().status).toBe('loading');
      await vi.advanceTimersByTimeAsync(10);
      expect(refreshCall).toHaveBeenCalledTimes(1);

      slow.resolve({ access: 'A', refresh: 'R2' });
      await vi.advanceTimersByTimeAsync(10);
      await retry;
      expect(refreshCall).toHaveBeenCalledTimes(1);
      expect(storage.value).toBe('R2');
      expect(store.getState().status).toBe('authenticated');
    });

    it('ignores the late result once the user left (new account signed in)', async () => {
      vi.useFakeTimers();
      const { store, storage, refreshCall } = setup();
      const slow = deferred<RefreshResponse>();
      refreshCall.mockReturnValue(slow.promise);

      const boot = store.getState().bootstrap();
      await vi.advanceTimersByTimeAsync(1001);
      await boot;
      await store.getState().leaveOffline();
      await store.getState().setSession({ access: 'B-access', refresh: 'B-refresh', user: USER_B });

      slow.resolve({ access: 'zombie', refresh: 'zombie-refresh' });
      await vi.advanceTimersByTimeAsync(10);

      expect(storage.value).toBe('B-refresh');
      expect(store.getState()).toMatchObject({ status: 'authenticated', accessToken: 'B-access', user: USER_B });
    });

    it('a stale /me failure cannot wipe a newer sign-in', async () => {
      const { store, storage, fetchMe } = setup();
      const me = deferred<User>();
      fetchMe.mockReturnValue(me.promise);

      const boot = store.getState().bootstrap();
      await flushMicrotasks();
      await store.getState().setSession({ access: 'B-access', refresh: 'B-refresh', user: USER_B });
      me.reject(httpError(403, 'account_disabled'));
      await boot;

      expect(storage.value).toBe('B-refresh');
      expect(store.getState()).toMatchObject({ status: 'authenticated', user: USER_B });
    });

    it('a stale /me success cannot overwrite the newer user', async () => {
      const { store, fetchMe } = setup();
      const me = deferred<User>();
      fetchMe.mockReturnValue(me.promise);

      const boot = store.getState().bootstrap();
      await flushMicrotasks();
      await store.getState().setSession({ access: 'B-access', refresh: 'B-refresh', user: USER_B });
      me.resolve(USER);
      await boot;

      expect(store.getState().user).toEqual(USER_B);
      expect(store.getState().accessToken).toBe('B-access');
    });

    it('does not hang when the secure store never answers: treated as an unreadable store', async () => {
      vi.useFakeTimers();
      const { store, storage } = setup();
      storage.get = () => new Promise(() => undefined);
      const boot = store.getState().bootstrap();
      await vi.advanceTimersByTimeAsync(300);
      await boot;
      expect(store.getState().status).toBe('offline');
    });
  });

  describe('permanently broken secure store', () => {
    it('stays offline for the first failures, then deletes the item and goes anonymous', async () => {
      const { store, storage } = setup();
      const clear = vi.fn(async () => {
        storage.value = null;
      });
      storage.get = async () => {
        throw new Error('keystore broken');
      };
      storage.clear = clear;

      await store.getState().bootstrap();
      expect(store.getState().status).toBe('offline');
      await store.getState().bootstrap();
      expect(store.getState().status).toBe('offline');
      expect(clear).not.toHaveBeenCalled();

      await store.getState().bootstrap();
      expect(clear).toHaveBeenCalled();
      expect(store.getState().status).toBe('anonymous');
    });

    it('resets the failure count after a successful read', async () => {
      const { store, storage } = setup();
      const get = storage.get;
      storage.get = async () => {
        throw new Error('flaky');
      };
      await store.getState().bootstrap();
      await store.getState().bootstrap();
      storage.get = get;
      await store.getState().bootstrap(); // success
      storage.get = async () => {
        throw new Error('flaky');
      };
      await store.getState().bootstrap();
      expect(store.getState().status).toBe('offline');
    });
  });

  describe('leaveOffline', () => {
    it('queues the stored refresh token for revocation, clears it, then goes anonymous', async () => {
      const { store, storage, pendingRevoke, refreshCall } = setup();
      refreshCall.mockRejectedValue(networkError());
      await store.getState().bootstrap();
      await store.getState().leaveOffline();

      expect(store.getState().status).toBe('anonymous');
      expect(storage.value).toBeNull();
      expect(pendingRevoke.list).toEqual([{ token: 'refresh-1', userId: null }]);
    });

    it('does nothing unless the status is offline', async () => {
      const { store, storage } = setup();
      await store.getState().bootstrap();
      await store.getState().leaveOffline();
      expect(store.getState().status).toBe('authenticated');
      expect(storage.value).toBe('refresh-2');
    });
  });

  describe('setSession', () => {
    it('persists refresh in storage and keeps only access + user in state', async () => {
      const { store, storage } = setup(null);
      await store.getState().setSession({ access: 'a', refresh: 'r', user: USER });
      expect(storage.value).toBe('r');
      expect(store.getState()).toMatchObject({ status: 'authenticated', accessToken: 'a', user: USER });
      expect(JSON.stringify(store.getState())).not.toContain('"r"');
    });

    it('ends anonymous and rejects when the secure store write fails', async () => {
      const { store, storage } = setup(null);
      storage.set = async () => {
        throw new Error('keystore broken');
      };
      await expect(store.getState().setSession({ access: 'a', refresh: 'r', user: USER })).rejects.toThrow(
        'keystore broken',
      );
      expect(store.getState()).toMatchObject({ status: 'anonymous', accessToken: null, user: null });
    });

    it('is not overwritten by an older refresh that finishes afterwards', async () => {
      const { store, storage, refreshCall } = setup('old-refresh');
      const slow = deferred<RefreshResponse>();
      refreshCall.mockReturnValue(slow.promise);

      const stale = store.getState().refreshAccess().catch(() => 'stale');
      await flushMicrotasks();
      await store.getState().setSession({ access: 'new-access', refresh: 'new-refresh', user: USER });
      slow.resolve({ access: 'old-access', refresh: 'old-rotated' });
      await stale;

      expect(storage.value).toBe('new-refresh');
      expect(store.getState().accessToken).toBe('new-access');
    });

    it('wins over an old refresh whose rotated token is being written right now', async () => {
      const { store, storage, refreshCall } = setup('R1');
      const writeGate = deferred();
      const writing = deferred();
      const realSet = storage.set;
      let first = true;
      storage.set = async (t: string) => {
        if (first) {
          first = false;
          writing.resolve();
          await writeGate.promise; // R2 write is slow
        }
        await realSet(t);
      };
      refreshCall.mockResolvedValue({ access: 'A2', refresh: 'R2' });

      const oldRefresh = store.getState().refreshAccess().catch((e: unknown) => e);
      await writing.promise;
      const signIn = store.getState().setSession({ access: 'B-access', refresh: 'B-refresh', user: USER_B });
      writeGate.resolve();
      await Promise.all([oldRefresh, signIn]);

      expect(storage.value).toBe('B-refresh');
      expect(store.getState()).toMatchObject({ status: 'authenticated', accessToken: 'B-access', user: USER_B });
    });

    it('clearSession during the R2 write leaves nothing behind (no zombie session)', async () => {
      const { store, storage, refreshCall } = setup('R1');
      await store.getState().bootstrap();
      const writeGate = deferred();
      const writing = deferred();
      const realSet = storage.set;
      storage.set = async (t: string) => {
        writing.resolve();
        await writeGate.promise;
        await realSet(t);
      };
      refreshCall.mockResolvedValue({ access: 'A3', refresh: 'R3' });

      const oldRefresh = store.getState().refreshAccess().catch((e: unknown) => e);
      await writing.promise;
      const cleared = store.getState().clearSession();
      writeGate.resolve();
      await Promise.all([oldRefresh, cleared]);

      expect(storage.value).toBeNull();
      expect(store.getState()).toMatchObject({ status: 'anonymous', accessToken: null, user: null });
    });

    it('two quick sign-ins end with the later account', async () => {
      const { store, storage } = setup(null);
      const a = store.getState().setSession({ access: 'a', refresh: 'ra', user: USER });
      const b = store.getState().setSession({ access: 'b', refresh: 'rb', user: USER_B });
      await Promise.all([a, b]);
      expect(storage.value).toBe('rb');
      expect(store.getState().user).toEqual(USER_B);
    });
  });

  describe('setUser', () => {
    it('replaces the user without touching the status', async () => {
      const { store } = setup();
      await store.getState().bootstrap();
      await store.getState().setUser({ ...USER, first_name: 'Vali' }, store.getState().getEpoch());
      expect(store.getState().user?.first_name).toBe('Vali');
      expect(store.getState().status).toBe('authenticated');
    });

    it('ignores a profile response that belongs to a previous session (logout + other account)', async () => {
      const { store } = setup();
      await store.getState().setSession({ access: 'a', refresh: 'ra', user: USER });
      const epochAtRequest = store.getState().getEpoch();
      await store.getState().logout();
      await store.getState().setSession({ access: 'b', refresh: 'rb', user: USER_B });

      await store.getState().setUser({ ...USER, first_name: 'LATE A PROFILE' }, epochAtRequest);

      expect(store.getState().user).toEqual(USER_B);
    });

    it('ignores the response when nobody is signed in any more', async () => {
      const { store } = setup();
      await store.getState().setSession({ access: 'a', refresh: 'ra', user: USER });
      const epochAtRequest = store.getState().getEpoch();
      await store.getState().clearSession();
      await store.getState().setUser({ ...USER, first_name: 'ghost' }, epochAtRequest);
      expect(store.getState()).toMatchObject({ user: null, status: 'anonymous' });
    });
  });

  describe('logout', () => {
    it('clears the local session immediately, even if the server never answers', async () => {
      const { store, storage, serverLogout, pendingRevoke } = setup();
      await store.getState().bootstrap();
      serverLogout.mockReturnValue(new Promise(() => undefined));

      await store.getState().logout();

      expect(store.getState()).toMatchObject({ status: 'anonymous', user: null, accessToken: null });
      expect(storage.value).toBeNull();
      // written BEFORE the wipe, so killing the app mid-revoke cannot lose it
      expect(pendingRevoke.list).toEqual([{ token: 'refresh-2', userId: 1 }]);
    });

    it('revokes the current token with the access token it captured, then dequeues it', async () => {
      const { store, serverLogout, pendingRevoke } = setup();
      await store.getState().bootstrap();
      await store.getState().logout();
      await vi.waitFor(() => expect(pendingRevoke.list).toEqual([]));
      expect(serverLogout).toHaveBeenCalledWith('refresh-2', 'access-2');
    });

    it('keeps the entry queued when the server is unreachable or answers 401/5xx', async () => {
      for (const error of [networkError(), httpError(401, 'token_not_valid'), httpError(503), httpError(403)]) {
        const { store, serverLogout, pendingRevoke } = setup();
        await store.getState().bootstrap();
        serverLogout.mockRejectedValue(error);
        await store.getState().logout();
        await vi.waitFor(() => expect(serverLogout).toHaveBeenCalled());
        await flushMicrotasks();
        expect(pendingRevoke.list).toHaveLength(1);
      }
    });

    it('dequeues an entry the server refuses as invalid (400 invalid_token)', async () => {
      const { store, serverLogout, pendingRevoke } = setup();
      await store.getState().bootstrap();
      serverLogout.mockRejectedValue(httpError(400, 'invalid_token'));
      await store.getState().logout();
      await vi.waitFor(() => expect(pendingRevoke.list).toEqual([]));
    });

    it('a second offline logout does not overwrite the first queued token', async () => {
      const { store, serverLogout, pendingRevoke } = setup();
      serverLogout.mockRejectedValue(networkError());
      await store.getState().setSession({ access: 'a1', refresh: 'T1', user: USER });
      await store.getState().logout();
      await store.getState().setSession({ access: 'a2', refresh: 'T2', user: USER });
      await store.getState().logout();
      await flushMicrotasks();
      expect(pendingRevoke.list.map((e) => e.token)).toEqual(['T1', 'T2']);
    });

    it('skips the server call when no refresh token exists', async () => {
      const { store, serverLogout } = setup(null);
      await store.getState().logout();
      expect(serverLogout).not.toHaveBeenCalled();
      expect(store.getState().status).toBe('anonymous');
    });

    it('waits for an in-flight refresh and revokes the rotated token, not the stale one', async () => {
      const { store, storage, refreshCall, serverLogout } = setup('refresh-1');
      await store.getState().bootstrap();
      const slow = deferred<RefreshResponse>();
      refreshCall.mockReturnValue(slow.promise);
      const inFlight = store.getState().refreshAccess();
      await flushMicrotasks();

      const loggingOut = store.getState().logout();
      await flushMicrotasks();
      expect(serverLogout).not.toHaveBeenCalled();
      slow.resolve({ access: 'a3', refresh: 'refresh-3' });
      await inFlight;
      await loggingOut;

      await vi.waitFor(() => expect(serverLogout).toHaveBeenCalledTimes(1));
      expect(serverLogout).toHaveBeenCalledWith('refresh-3', 'a3');
      expect(storage.value).toBeNull();
      expect(store.getState().status).toBe('anonymous');
    });

    it('never rejects, even when the secure store fails', async () => {
      const { store, storage } = setup();
      await store.getState().bootstrap();
      storage.clear = async () => {
        throw new Error('keystore broken');
      };
      await expect(store.getState().logout()).resolves.toBeUndefined();
      expect(store.getState().status).toBe('anonymous');
    });
  });

  describe('queued revocations after the next sign-in', () => {
    it('revokes entries of the same user (and unknown owner) with the new access token', async () => {
      const { store, pendingRevoke, serverLogout } = setup();
      pendingRevoke.list = [
        { token: 'mine', userId: 1 },
        { token: 'unknown-owner', userId: null },
      ];
      await store.getState().setSession({ access: 'a', refresh: 'r', user: USER });
      await vi.waitFor(() => expect(pendingRevoke.list).toEqual([]));
      expect(serverLogout).toHaveBeenCalledWith('mine', 'a');
      expect(serverLogout).toHaveBeenCalledWith('unknown-owner', 'a');
    });

    it("drops another user's entries without calling the server (it could never revoke them)", async () => {
      const { store, pendingRevoke, serverLogout } = setup();
      pendingRevoke.list = [{ token: 'theirs', userId: 99 }];
      await store.getState().setSession({ access: 'a', refresh: 'r', user: USER });
      await vi.waitFor(() => expect(pendingRevoke.list).toEqual([]));
      expect(serverLogout).not.toHaveBeenCalled();
    });

    it('keeps entries on network failure and on 401 (expired access is not a verdict on the old token)', async () => {
      for (const error of [networkError(), httpError(401, 'token_not_valid')]) {
        const { store, pendingRevoke, serverLogout } = setup();
        pendingRevoke.list = [{ token: 'queued', userId: 1 }];
        serverLogout.mockRejectedValue(error);
        await store.getState().setSession({ access: 'a', refresh: 'r', user: USER });
        await vi.waitFor(() => expect(serverLogout).toHaveBeenCalled());
        await flushMicrotasks();
        expect(pendingRevoke.list).toHaveLength(1);
      }
    });

    it('drops an entry the server refuses (400 invalid_token)', async () => {
      const { store, pendingRevoke, serverLogout } = setup();
      pendingRevoke.list = [{ token: 'queued', userId: null }];
      serverLogout.mockRejectedValue(httpError(400, 'invalid_token'));
      await store.getState().setSession({ access: 'a', refresh: 'r', user: USER });
      await vi.waitFor(() => expect(pendingRevoke.list).toEqual([]));
    });

    it('also flushes after a successful bootstrap', async () => {
      const { store, pendingRevoke, serverLogout } = setup();
      pendingRevoke.list = [{ token: 'queued', userId: 1 }];
      await store.getState().bootstrap();
      await vi.waitFor(() => expect(serverLogout).toHaveBeenCalledWith('queued', 'access-2'));
    });
  });

  describe('clearSession', () => {
    it('drops local state without calling the server', async () => {
      const { store, storage, serverLogout } = setup();
      await store.getState().bootstrap();
      await store.getState().clearSession();
      expect(serverLogout).not.toHaveBeenCalled();
      expect(storage.value).toBeNull();
      expect(store.getState()).toMatchObject({ status: 'anonymous', user: null, accessToken: null });
    });

    it('ends anonymous and does not reject when storage.clear fails', async () => {
      const { store, storage } = setup();
      await store.getState().bootstrap();
      storage.clear = async () => {
        throw new Error('keystore broken');
      };
      await expect(store.getState().clearSession()).resolves.toBeUndefined();
      expect(store.getState().status).toBe('anonymous');
    });

    it('a failed clear is retried at the next start: the old session is not resurrected', async () => {
      const { store, storage, pendingClear } = setup();
      await store.getState().bootstrap();
      const realClear = storage.clear;
      storage.clear = async () => {
        throw new Error('keystore broken');
      };
      await store.getState().clearSession();
      expect(pendingClear.value).not.toBeNull();

      // "next launch": storage works again, the token is still there
      storage.clear = realClear;
      const next = setupWith(storage, pendingClear);
      await next.store.getState().bootstrap();

      expect(next.store.getState().status).toBe('anonymous');
      expect(storage.value).toBeNull();
      expect(pendingClear.value).toBeNull();
      expect(next.refreshCall).not.toHaveBeenCalled();
    });

    it('a new sign-in cancels a pending clear so it cannot wipe the new session later', async () => {
      const { store, storage, pendingClear } = setup();
      pendingClear.value = '1';
      await store.getState().setSession({ access: 'a', refresh: 'r', user: USER });
      expect(pendingClear.value).toBeNull();
      expect(storage.value).toBe('r');
    });
  });

  describe('refreshAccess', () => {
    it('single-flights concurrent refreshes and publishes the new access token', async () => {
      const { store, refreshCall } = setup();
      const [a, b] = await Promise.all([store.getState().refreshAccess(), store.getState().refreshAccess()]);
      expect([a, b]).toEqual(['access-2', 'access-2']);
      expect(refreshCall).toHaveBeenCalledTimes(1);
      expect(store.getState().accessToken).toBe('access-2');
    });
  });

  describe('getEpoch', () => {
    it('changes whenever the session is replaced or destroyed', async () => {
      const { store } = setup(null);
      const e0 = store.getState().getEpoch();
      await store.getState().setSession({ access: 'a', refresh: 'r', user: USER });
      const e1 = store.getState().getEpoch();
      await store.getState().clearSession();
      const e2 = store.getState().getEpoch();
      expect(new Set([e0, e1, e2]).size).toBe(3);
    });
  });
});

describe('auth store: hung secure store (lock must never stay held)', () => {
  const never = () => new Promise<never>(() => undefined);

  it('logout still finishes and ends anonymous when every storage call hangs', async () => {
    vi.useFakeTimers();
    const { store, storage, pendingClear, pendingRevoke } = setup('r1', { storageTimeoutMs: 200 });
    await store.getState().setSession({ access: 'a', refresh: 'r1', user: USER });
    storage.get = never;
    storage.set = never;
    storage.clear = never;
    pendingClear.get = never;
    pendingClear.set = never;
    pendingClear.clear = never;
    pendingRevoke.read = never;
    pendingRevoke.write = never;

    const loggingOut = store.getState().logout();
    await vi.advanceTimersByTimeAsync(5000);
    await loggingOut;

    expect(store.getState()).toMatchObject({ status: 'anonymous', user: null, accessToken: null });
  });

  it('the lock is released afterwards: a later sign-in still works once storage recovers', async () => {
    vi.useFakeTimers();
    const { store, storage } = setup('r1', { storageTimeoutMs: 200 });
    const realClear = storage.clear;
    storage.clear = never;
    const clearing = store.getState().clearSession();
    await vi.advanceTimersByTimeAsync(1000);
    await clearing;
    expect(store.getState().status).toBe('anonymous');

    storage.clear = realClear;
    await store.getState().setSession({ access: 'b', refresh: 'rb', user: USER_B });
    expect(store.getState()).toMatchObject({ status: 'authenticated', user: USER_B });
    expect(storage.value).toBe('rb');
  });

  it('tries to leave a pending-clear marker when the token could not be deleted', async () => {
    vi.useFakeTimers();
    const { store, storage, pendingClear } = setup('r1', { storageTimeoutMs: 200 });
    storage.clear = never;
    const clearing = store.getState().clearSession();
    await vi.advanceTimersByTimeAsync(1000);
    await clearing;
    expect(pendingClear.value).toBe('1');
  });

  it('setSession fails (and ends anonymous) instead of hanging when the store hangs', async () => {
    vi.useFakeTimers();
    const { store, storage } = setup(null, { storageTimeoutMs: 200 });
    storage.set = never;
    const result = store
      .getState()
      .setSession({ access: 'a', refresh: 'r', user: USER })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBeInstanceOf(Error);
    expect(store.getState().status).toBe('anonymous');
  });

  it('logout does not wait for a hung in-flight refresh: settle is bounded', async () => {
    vi.useFakeTimers();
    const { store, refreshCall } = setup('r1', { settleTimeoutMs: 100 });
    await store.getState().bootstrap();
    refreshCall.mockReturnValue(never());
    void store.getState().refreshAccess().catch(() => undefined);
    await flushMicrotasks();

    const loggingOut = store.getState().logout();
    await vi.advanceTimersByTimeAsync(150);
    await loggingOut;
    expect(store.getState().status).toBe('anonymous');
  });
});

describe('auth store: leaveOffline ordering', () => {
  it('does not bump the session epoch when the status is not offline', async () => {
    const { store } = setup();
    await store.getState().bootstrap();
    const before = store.getState().getEpoch();
    await store.getState().leaveOffline();
    expect(store.getState().getEpoch()).toBe(before);
    expect(store.getState().status).toBe('authenticated');
  });

  it('a sign-in requested right after leaveOffline still lands (not dropped as superseded)', async () => {
    const { store, storage, refreshCall } = setup();
    refreshCall.mockRejectedValue(networkError());
    await store.getState().bootstrap();
    expect(store.getState().status).toBe('offline');

    const leaving = store.getState().leaveOffline();
    const signIn = store.getState().setSession({ access: 'b', refresh: 'rb', user: USER_B });
    await Promise.all([leaving, signIn]);

    expect(storage.value).toBe('rb');
    expect(store.getState()).toMatchObject({ status: 'authenticated', user: USER_B });
  });

  it('a sign-in requested while a conditional wipe is queued also lands', async () => {
    const { store, storage, fetchMe } = setup();
    fetchMe.mockRejectedValue(httpError(401, 'user_inactive'));
    const booting = store.getState().bootstrap();
    await flushMicrotasks();
    const signIn = store.getState().setSession({ access: 'b', refresh: 'rb', user: USER_B });
    await Promise.all([booting, signIn]);
    expect(storage.value).toBe('rb');
    expect(store.getState().user).toEqual(USER_B);
  });
});

describe('auth store: inactive / deleted accounts close the session', () => {
  it.each(['no_active_account', 'user_inactive', 'user_not_found'])(
    'a 401 %s on refresh ends the session cleanly (no offline loop)',
    async (code) => {
      const { store, storage, refreshCall } = setup();
      refreshCall.mockRejectedValue(httpError(401, code));
      await store.getState().bootstrap();
      expect(store.getState().status).toBe('anonymous');
      expect(storage.value).toBeNull();
    },
  );

  it('a 401 user_inactive on /me ends the session too', async () => {
    const { store, storage, fetchMe } = setup();
    fetchMe.mockRejectedValue(httpError(401, 'user_inactive'));
    await store.getState().bootstrap();
    expect(store.getState().status).toBe('anonymous');
    expect(storage.value).toBeNull();
  });
});

describe('auth store: epoch-guarded bootstrap state', () => {
  it('a timed-out attempt does not flip a newer session to offline', async () => {
    vi.useFakeTimers();
    const { store, refreshCall } = setup();
    refreshCall.mockReturnValue(new Promise(() => undefined));
    const boot = store.getState().bootstrap();
    await flushMicrotasks();
    await store.getState().setSession({ access: 'b', refresh: 'rb', user: USER_B });
    await vi.advanceTimersByTimeAsync(1001);
    await boot;
    expect(store.getState().status).toBe('authenticated');
  });

  it('the verification refresh is bound to the epoch it started in', async () => {
    const { store, storage, refreshCall, pendingClear } = setup();
    const gate = deferred<string | null>();
    pendingClear.get = () => gate.promise;
    const boot = store.getState().bootstrap();
    await flushMicrotasks();
    await store.getState().setSession({ access: 'b', refresh: 'rb', user: USER_B });
    gate.resolve(null);
    await boot;
    expect(refreshCall).not.toHaveBeenCalled(); // never rotated the new account's token
    expect(storage.value).toBe('rb');
  });
});

describe('auth store: pending revoke overflow', () => {
  it('logs (without any token) when the oldest queued revocation is dropped', async () => {
    const warn = vi.fn();
    const { store, pendingRevoke, serverLogout } = setup(null, { logger: { warn } });
    serverLogout.mockRejectedValue(networkError());
    pendingRevoke.list = ['t1', 't2', 't3', 't4'].map((token) => ({ token, userId: 1 }));
    await store.getState().setSession({ access: 'a', refresh: 'SECRET-REFRESH', user: USER });
    await store.getState().logout();
    await flushMicrotasks();

    expect(pendingRevoke.list).toHaveLength(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/dropped/i);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-REFRESH');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('t1');
  });
});

/** A second app launch sharing the same persisted storage. */
function setupWith(storage: MemoryStorage, pendingClear: MemoryStorage) {
  const refreshCall = vi.fn<(t: string) => Promise<RefreshResponse>>().mockResolvedValue({ access: 'x', refresh: 'y' });
  const store = createAuthStore({
    storage,
    pendingClear,
    pendingRevoke: memoryPending(),
    refreshCall,
    fetchMe: vi.fn().mockResolvedValue(USER),
    serverLogout: vi.fn().mockResolvedValue(undefined),
  });
  return { store, refreshCall };
}
