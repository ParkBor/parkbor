import { AxiosError, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTokenRefresher,
  SessionExpiredError,
  StaleRefreshError,
  StorageReadError,
  type RefreshStorage,
} from '@/lib/refresh';
import { createTokenLock } from '@/lib/tokenLock';
import type { RefreshResponse } from '@/lib/types';

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

const ticks = async () => {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
};

function build(storage: RefreshStorage, call = vi.fn<(t: string) => Promise<RefreshResponse>>()) {
  const onAccessToken = vi.fn();
  const state = { epoch: 0 };
  const lock = createTokenLock();
  const refresher = createTokenRefresher({
    storage,
    refreshCall: call,
    onAccessToken,
    getEpoch: () => state.epoch,
    lock,
    storageTimeoutMs: 100,
  });
  return { ...refresher, call, onAccessToken, state, lock };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createTokenRefresher', () => {
  it('refuses to start for an epoch that is already gone (no read, no network)', async () => {
    const storage = memoryStorage('r');
    const get = vi.spyOn(storage, 'get');
    const { refresh, call, state } = build(storage);
    state.epoch = 5;
    await expect(refresh(4)).rejects.toBeInstanceOf(StaleRefreshError);
    expect(get).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it('a hung secure store cannot hold the lock: persisting gives up and expires the session', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage('r');
    const never = () => new Promise<never>(() => undefined);
    const { refresh, call, lock } = build({ ...storage, set: never, clear: never });
    call.mockResolvedValue({ access: 'A', refresh: 'R2' });

    const result = refresh().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBeInstanceOf(SessionExpiredError);

    // the lock is free again
    await expect(lock.run(async () => 'free')).resolves.toBe('free');
  });

  it('rotates: stores the new refresh token and publishes the access token', async () => {
    const storage = memoryStorage('old-refresh');
    const { refresh, call, onAccessToken } = build(storage);
    call.mockResolvedValue({ access: 'A2', refresh: 'new-refresh' });

    await expect(refresh()).resolves.toBe('A2');

    expect(call).toHaveBeenCalledWith('old-refresh');
    expect(storage.value).toBe('new-refresh');
    expect(onAccessToken).toHaveBeenCalledWith('A2');
  });

  it('keeps the old refresh token when the server does not rotate', async () => {
    const storage = memoryStorage('old-refresh');
    const { refresh, call } = build(storage);
    call.mockResolvedValue({ access: 'A2' });
    await refresh();
    expect(storage.value).toBe('old-refresh');
  });

  it('is single-flight: concurrent callers share one request', async () => {
    const storage = memoryStorage('r');
    const { refresh, call } = build(storage);
    let resolve!: (v: RefreshResponse) => void;
    call.mockReturnValue(new Promise((r) => (resolve = r)));

    const all = Promise.all([refresh(), refresh(), refresh()]);
    await ticks();
    resolve({ access: 'A', refresh: 'r2' });

    await expect(all).resolves.toEqual(['A', 'A', 'A']);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('allows a new refresh after the previous one settled', async () => {
    const storage = memoryStorage('r');
    const { refresh, call } = build(storage);
    call
      .mockResolvedValueOnce({ access: 'A1', refresh: 'r1' })
      .mockResolvedValueOnce({ access: 'A2', refresh: 'r2' });
    await refresh();
    await expect(refresh()).resolves.toBe('A2');
    expect(call).toHaveBeenLastCalledWith('r1');
  });

  it('throws SessionExpiredError when there is no refresh token', async () => {
    const { refresh, call } = build(memoryStorage(null));
    await expect(refresh()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'token_not_valid'],
    [400, 'invalid_token'],
    [403, 'account_disabled'],
  ])('clears storage and expires the session on %i %s', async (status, code) => {
    const storage = memoryStorage('r');
    const { refresh, call } = build(storage);
    call.mockRejectedValue(httpError(status, code));
    await expect(refresh()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(storage.value).toBeNull();
  });

  it.each([
    [401, undefined],
    [403, undefined],
    [404, undefined],
    [408, undefined],
    [410, undefined],
    [400, undefined],
    [400, 'validation_error'],
    [429, undefined],
    [500, undefined],
    [503, undefined],
  ])('keeps the session on non-rejecting %i %s', async (status, code) => {
    const storage = memoryStorage('r');
    const { refresh, call } = build(storage);
    call.mockRejectedValue(httpError(status, code));
    await expect(refresh()).rejects.not.toBeInstanceOf(SessionExpiredError);
    expect(storage.value).toBe('r');
  });

  it('keeps the session on network failure', async () => {
    const storage = memoryStorage('r');
    const { refresh, call } = build(storage);
    call.mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK'));
    await expect(refresh()).rejects.toBeInstanceOf(AxiosError);
    expect(storage.value).toBe('r');
  });

  describe('epoch (session generation)', () => {
    it('discards the result when the session changed while the request was in flight', async () => {
      const storage = memoryStorage('old');
      const { refresh, call, onAccessToken, state } = build(storage);
      let resolve!: (v: RefreshResponse) => void;
      call.mockReturnValue(new Promise((r) => (resolve = r)));

      const pending = refresh();
      await ticks();
      state.epoch += 1; // logout / setSession happened
      storage.value = null;
      resolve({ access: 'A', refresh: 'rotated' });

      await expect(pending).rejects.toBeInstanceOf(StaleRefreshError);
      expect(storage.value).toBeNull();
      expect(onAccessToken).not.toHaveBeenCalled();
    });

    it('does not wipe a newer session when a stale refresh is rejected', async () => {
      const storage = memoryStorage('old');
      const { refresh, call, state } = build(storage);
      let reject!: (e: unknown) => void;
      call.mockReturnValue(new Promise((_, r) => (reject = r)));

      const pending = refresh();
      await ticks();
      state.epoch += 1;
      storage.value = 'new-session-refresh';
      reject(httpError(401));

      await expect(pending).rejects.toBeInstanceOf(StaleRefreshError);
      expect(storage.value).toBe('new-session-refresh');
    });

    it('does not join a stale in-flight refresh after the epoch changed', async () => {
      const storage = memoryStorage('r');
      const { refresh, call, state } = build(storage);
      call.mockReturnValueOnce(new Promise(() => undefined));
      void refresh().catch(() => undefined);
      await ticks();
      state.epoch += 1;
      call.mockResolvedValueOnce({ access: 'A-new', refresh: 'r-new' });

      await expect(refresh()).resolves.toBe('A-new');
      expect(call).toHaveBeenCalledTimes(2);
    });
  });

  describe('storage failures', () => {
    it('reports an unreadable secure store distinctly (and does not call the server)', async () => {
      const storage = memoryStorage('r');
      storage.get = async () => {
        throw new Error('keystore broken');
      };
      const { refresh, call } = build(storage);
      await expect(refresh()).rejects.toBeInstanceOf(StorageReadError);
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe('commit under the shared lock', () => {
    function gatedSet(storage: MemoryStorage) {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const isEntered = new Promise<void>((r) => (entered = r));
      storage.set = async (t: string) => {
        entered();
        await gate;
        storage.value = t;
      };
      return { release, isEntered };
    }

    it('a sign-in queued while R2 is being written lands AFTER it (account switch)', async () => {
      const storage = memoryStorage('R1');
      const { release, isEntered } = gatedSet(storage);
      const { refresh, call, lock, state, onAccessToken } = build(storage);
      call.mockResolvedValue({ access: 'A2', refresh: 'R2' });

      const pending = refresh().catch((e: unknown) => e);
      await isEntered; // commit is mid-write
      state.epoch += 1; // setSession(B) starts...
      const signInB = lock.run(async () => {
        storage.value = 'B-refresh'; // ...and writes under the lock
      });
      release();

      expect(await pending).toBeInstanceOf(StaleRefreshError);
      await signInB;
      expect(storage.value).toBe('B-refresh');
      expect(onAccessToken).not.toHaveBeenCalled();
    });

    it('a sign-out queued while R2 is being written leaves nothing behind', async () => {
      const storage = memoryStorage('R1');
      const { release, isEntered } = gatedSet(storage);
      const { refresh, call, lock, state } = build(storage);
      call.mockResolvedValue({ access: 'A2', refresh: 'R2' });

      const pending = refresh().catch((e: unknown) => e);
      await isEntered;
      state.epoch += 1;
      const signOut = lock.run(async () => {
        storage.value = null;
      });
      release();

      await pending;
      await signOut;
      expect(storage.value).toBeNull();
    });

    it('drops a result whose epoch changed while waiting for the lock (nothing written)', async () => {
      const storage = memoryStorage('R1');
      const { refresh, call, lock, state, onAccessToken } = build(storage);
      let hold!: () => void;
      const held = lock.run(() => new Promise<void>((r) => (hold = r)));
      call.mockResolvedValue({ access: 'A2', refresh: 'R2' });

      const pending = refresh().catch((e: unknown) => e);
      await vi.waitFor(() => expect(call).toHaveBeenCalled());
      await Promise.resolve();
      state.epoch += 1; // session replaced while we queue behind the lock holder
      hold();
      await held;

      expect(await pending).toBeInstanceOf(StaleRefreshError);
      expect(storage.value).toBe('R1');
      expect(onAccessToken).not.toHaveBeenCalled();
    });

    it('does not clear or expire a session that is not ours when persisting keeps failing', async () => {
      const storage = memoryStorage('R1');
      const clear = vi.fn(async () => undefined);
      const { refresh, call, state } = build({
        ...storage,
        clear,
        set: async () => {
          state.epoch += 1; // the session is replaced while we are failing to write
          throw new Error('keystore busy');
        },
      });
      call.mockResolvedValue({ access: 'A2', refresh: 'R2' });
      await expect(refresh()).rejects.toBeInstanceOf(StaleRefreshError);
      expect(clear).not.toHaveBeenCalled();
    });

    it('a rejected token is not wiped from storage if the session already changed', async () => {
      const storage = memoryStorage('R1');
      const { refresh, call, state } = build(storage);
      call.mockImplementation(async () => {
        state.epoch += 1;
        storage.value = 'someone-elses-refresh';
        throw httpError(401, 'token_not_valid');
      });
      await expect(refresh()).rejects.toBeInstanceOf(StaleRefreshError);
      expect(storage.value).toBe('someone-elses-refresh');
    });
  });

  describe('settle', () => {
    it('resolves immediately when nothing is in flight', async () => {
      const { settle } = build(memoryStorage('r'));
      await expect(settle()).resolves.toBeUndefined();
    });

    it('waits for an in-flight refresh and swallows its failure', async () => {
      const { refresh, settle, call } = build(memoryStorage('r'));
      call.mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK'));
      const pending = refresh().catch(() => undefined);
      await expect(settle()).resolves.toBeUndefined();
      await pending;
    });
  });

  describe('persisting the rotated token', () => {
    it('retries once when the secure store write fails', async () => {
      const storage = memoryStorage('r');
      const set = vi
        .fn<(t: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error('keystore busy'))
        .mockImplementationOnce(async (t) => {
          storage.value = t;
        });
      const { refresh, call } = build({ ...storage, set });
      call.mockResolvedValue({ access: 'A', refresh: 'r2' });
      await expect(refresh()).resolves.toBe('A');
      expect(set).toHaveBeenCalledTimes(2);
      expect(storage.value).toBe('r2');
    });

    it('expires the session when the rotated token cannot be stored (old one is blacklisted)', async () => {
      const storage = memoryStorage('r');
      const clear = vi.fn(async () => {
        storage.value = null;
      });
      const set = vi.fn().mockRejectedValue(new Error('keystore broken'));
      const { refresh, call, onAccessToken } = build({ ...storage, set, clear });
      call.mockResolvedValue({ access: 'A', refresh: 'r2' });

      await expect(refresh()).rejects.toBeInstanceOf(SessionExpiredError);
      expect(clear).toHaveBeenCalled();
      expect(onAccessToken).not.toHaveBeenCalled();
    });
  });
});
