import { describe, expect, it, vi } from 'vitest';

import {
  bindQrCacheToSession,
  createQrCache,
  MAX_ENTRIES,
  MAX_TOKEN_LENGTH,
  type KeyValueStore,
} from '@/features/booking/qrCache';

const A = 'a0000000-1111-4222-8333-444455556666';
const B = 'b0000000-1111-4222-8333-444455556666';
const C = 'c0000000-1111-4222-8333-444455556666';
const NOW = 1_000_000;

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => void data.set(key, value),
    removeItem: async (key) => void data.delete(key),
  };
}

const token = (n = 100): string => 'T'.repeat(n);

describe('qrCache save/load', () => {
  it('round-trips a token until it expires', async () => {
    const cache = createQrCache(memoryStore(), () => NOW);
    expect(await cache.save(A, { token: token(), expiresAtMs: NOW + 60_000 })).toBe(true);
    expect(await cache.load(A)).toEqual({ token: token(), expiresAtMs: NOW + 60_000 });
  });

  it('does not serve (and removes) an expired token', async () => {
    const store = memoryStore();
    let now = NOW;
    const cache = createQrCache(store, () => now);
    await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 });
    now = NOW + 1000;
    expect(await cache.load(A)).toBeNull();
    expect([...store.data.keys()].filter((k) => k.includes(A))).toEqual([]);
  });

  it('refuses to store an already expired token', async () => {
    const store = memoryStore();
    const cache = createQrCache(store, () => NOW);
    expect(await cache.save(A, { token: token(), expiresAtMs: NOW })).toBe(false);
    expect(store.data.size).toBe(0);
  });

  it('refuses oversized, empty and non-ASCII tokens (SecureStore ~2 KB limit)', async () => {
    const store = memoryStore();
    const cache = createQrCache(store, () => NOW);
    const entry = (t: string) => ({ token: t, expiresAtMs: NOW + 1000 });
    expect(await cache.save(A, entry(token(MAX_TOKEN_LENGTH + 1)))).toBe(false);
    expect(await cache.save(A, entry(''))).toBe(false);
    expect(await cache.save(A, entry('токен-токен'))).toBe(false);
    expect(await cache.save(A, entry(token(MAX_TOKEN_LENGTH)))).toBe(true);
  });

  it('refuses ids that are not UUIDs (they become storage keys)', async () => {
    const store = memoryStore();
    const cache = createQrCache(store, () => NOW);
    expect(await cache.save('../../x', { token: token(), expiresAtMs: NOW + 1000 })).toBe(false);
    expect(await cache.load('../../x')).toBeNull();
    expect(store.data.size).toBe(0);
  });

  it('treats corrupt stored values as a miss', async () => {
    const store = memoryStore();
    const cache = createQrCache(store, () => NOW);
    await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 });
    const key = [...store.data.keys()].find((k) => k.includes(A));
    store.data.set(key!, '{not json');
    expect(await cache.load(A)).toBeNull();
    store.data.set(key!, JSON.stringify({ t: 5, e: 'x' }));
    expect(await cache.load(A)).toBeNull();
  });
});

describe('qrCache bounds', () => {
  it('keeps at most MAX_ENTRIES tokens, evicting the oldest', async () => {
    const store = memoryStore();
    const cache = createQrCache(store, () => NOW);
    await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 });
    await cache.save(B, { token: token(), expiresAtMs: NOW + 1000 });
    await cache.save(C, { token: token(), expiresAtMs: NOW + 1000 });
    expect(MAX_ENTRIES).toBe(2);
    expect(await cache.load(A)).toBeNull();
    expect(await cache.load(B)).not.toBeNull();
    expect(await cache.load(C)).not.toBeNull();
    expect([...store.data.keys()].filter((k) => k.includes(A))).toEqual([]);
  });

  it('re-saving the same booking replaces it without evicting another', async () => {
    const cache = createQrCache(memoryStore(), () => NOW);
    await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 });
    await cache.save(B, { token: token(), expiresAtMs: NOW + 1000 });
    await cache.save(B, { token: token(50), expiresAtMs: NOW + 2000 });
    expect((await cache.load(A))?.token).toBe(token());
    expect((await cache.load(B))?.token).toBe(token(50));
  });

  it('concurrent saves keep the index consistent', async () => {
    const store = memoryStore();
    const cache = createQrCache(store, () => NOW);
    await Promise.all([A, B, C].map((id) => cache.save(id, { token: token(), expiresAtMs: NOW + 1000 })));
    const loaded = await Promise.all([A, B, C].map((id) => cache.load(id)));
    expect(loaded.filter(Boolean)).toHaveLength(MAX_ENTRIES);
  });
});

describe('qrCache clearing', () => {
  it('clearAll removes every token and the index', async () => {
    const store = memoryStore();
    const cache = createQrCache(store, () => NOW);
    await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 });
    await cache.save(B, { token: token(), expiresAtMs: NOW + 1000 });
    await cache.clearAll();
    expect(store.data.size).toBe(0);
    expect(await cache.load(A)).toBeNull();
  });

  it('remove drops one booking (e.g. it was cancelled)', async () => {
    const cache = createQrCache(memoryStore(), () => NOW);
    await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 });
    await cache.save(B, { token: token(), expiresAtMs: NOW + 1000 });
    await cache.remove(A);
    expect(await cache.load(A)).toBeNull();
    expect(await cache.load(B)).not.toBeNull();
  });

  it('prune removes expired entries only', async () => {
    let now = NOW;
    const store = memoryStore();
    const cache = createQrCache(store, () => now);
    await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 });
    await cache.save(B, { token: token(), expiresAtMs: NOW + 9000 });
    now = NOW + 2000;
    await cache.prune();
    expect([...store.data.keys()].filter((k) => k.includes(A))).toEqual([]);
    expect(await cache.load(B)).not.toBeNull();
  });
});

describe('qrCache fails soft', () => {
  it('a broken store never throws into the UI', async () => {
    const broken: KeyValueStore = {
      getItem: vi.fn().mockRejectedValue(new Error('keystore locked')),
      setItem: vi.fn().mockRejectedValue(new Error('keystore locked')),
      removeItem: vi.fn().mockRejectedValue(new Error('keystore locked')),
    };
    const cache = createQrCache(broken, () => NOW);
    expect(await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 })).toBe(false);
    expect(await cache.load(A)).toBeNull();
    await expect(cache.clearAll()).resolves.toBeUndefined();
    await expect(cache.prune()).resolves.toBeUndefined();
  });

  it('error messages never include the token', async () => {
    const seen: unknown[] = [];
    const broken: KeyValueStore = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error('write failed');
      },
      removeItem: async () => undefined,
    };
    const cache = createQrCache(broken, () => NOW, (error) => seen.push(error));
    await cache.save(A, { token: 'SECRET-TOKEN-VALUE', expiresAtMs: NOW + 1000 });
    expect(JSON.stringify(seen.map(String))).not.toContain('SECRET');
  });
});

describe('bindQrCacheToSession', () => {
  it('clears the cache when the session ends', () => {
    const listeners: ((s: { status: string; user: null }) => void)[] = [];
    const cache = { clearAll: vi.fn().mockResolvedValue(undefined) };
    bindQrCacheToSession(cache, {
      getState: () => ({ status: 'authenticated', user: { id: '1' } }),
      subscribe: (l) => {
        listeners.push(l as (typeof listeners)[number]);
        return () => undefined;
      },
    });
    listeners.forEach((l) => l({ status: 'anonymous', user: null }));
    expect(cache.clearAll).toHaveBeenCalledTimes(1);
  });
});

describe('qrCache logout race (epoch)', () => {
  it('a token fetched before clearAll is not written after it', async () => {
    const store = memoryStore();
    const cache = createQrCache(store, () => NOW);
    const epochAtRequest = cache.epoch();
    await cache.clearAll(); // logout while the response was in flight
    const saved = await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 }, epochAtRequest);
    expect(saved).toBe(false);
    expect(store.data.size).toBe(0);
  });

  it('clearAll queued behind a running save still wins over a later save of the old epoch', async () => {
    const store = memoryStore();
    const cache = createQrCache(store, () => NOW);
    const epoch = cache.epoch();
    const first = cache.save(A, { token: token(), expiresAtMs: NOW + 1000 }, epoch);
    const clearing = cache.clearAll();
    const second = cache.save(B, { token: token(), expiresAtMs: NOW + 1000 }, epoch);
    await Promise.all([first, clearing, second]);
    expect(store.data.size).toBe(0);
  });

  it('a save with the current epoch works after a clear', async () => {
    const cache = createQrCache(memoryStore(), () => NOW);
    await cache.clearAll();
    expect(await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 }, cache.epoch())).toBe(true);
  });
});

describe('qrCache write order (no orphans)', () => {
  it('the index is written before the entry, so a failed entry write leaves nothing unreachable', async () => {
    const store = memoryStore();
    const failingEntry: KeyValueStore = {
      ...store,
      setItem: async (key, value) => {
        if (key !== 'habi.qr.index') throw new Error('disk full');
        store.data.set(key, value);
      },
    };
    const cache = createQrCache(failingEntry, () => NOW);
    expect(await cache.save(A, { token: token(), expiresAtMs: NOW + 1000 }, cache.epoch())).toBe(false);
    await cache.clearAll();
    expect(store.data.size).toBe(0);
  });
});
