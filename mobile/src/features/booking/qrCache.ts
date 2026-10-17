import { MAX_QR_TOKEN_LENGTH } from '@/features/booking/bookingSchemas';
import { isUuid } from '@/lib/contract';
import { onSessionEnd, type SessionSource } from '@/lib/sessionEnd';

/** Tokens are <= 1024 characters (backend); SecureStore values should stay under ~2 KB. */
export const MAX_TOKEN_LENGTH = MAX_QR_TOKEN_LENGTH;
/** Only the bookings a driver may need right now: a current one and the next one. */
export const MAX_ENTRIES = 2;

const INDEX_KEY = 'habi.qr.index';
const ENTRY_PREFIX = 'habi.qr.';
const ASCII_PRINTABLE = /^[!-~]+$/;

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface QrEntry {
  token: string;
  expiresAtMs: number;
}

export interface QrCache {
  /**
   * false when the token was refused or could not be stored. Pass the `epoch()` read BEFORE the
   * request: a response that arrives after a logout (clearAll) is then refused.
   */
  save(bookingId: string, entry: QrEntry, epoch?: number): Promise<boolean>;
  /** Increases on every clearAll (logout / account switch). */
  epoch(): number;
  /** The token, or null when absent, expired or unreadable. */
  load(bookingId: string): Promise<QrEntry | null>;
  remove(bookingId: string): Promise<void>;
  /** Drops expired entries. */
  prune(): Promise<void>;
  /** Logout / account switch: nothing of the previous session may stay on the device. */
  clearAll(): Promise<void>;
}

const entryKey = (bookingId: string): string => `${ENTRY_PREFIX}${bookingId}`;

function parseIndex(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(isUuid).slice(0, MAX_ENTRIES + 1) : [];
  } catch {
    return [];
  }
}

function parseEntry(raw: string | null): QrEntry | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as { t?: unknown; e?: unknown };
    if (typeof value.t !== 'string' || typeof value.e !== 'number' || !Number.isFinite(value.e)) return null;
    return { token: value.t, expiresAtMs: value.e };
  } catch {
    return null;
  }
}

/**
 * Short-lived offline copy of the QR token (ARCHITECTURE 13.2 "QR oflayn ham ko'rinadi"), kept in
 * the platform keystore - never in the query cache or AsyncStorage, which are plain files.
 *
 * - keyed by booking id (UUID-checked: ids become storage keys), at most MAX_ENTRIES kept;
 * - dropped at `expires_at`, on cancellation, on logout / account switch;
 * - best effort: storage failures never reach the UI (`onError` receives the Error only - the
 *   token, plate and ids are never part of any message or log).
 * Operations are serialised, so concurrent saves cannot corrupt the index.
 */
export function createQrCache(
  store: KeyValueStore,
  now: () => number,
  onError: (error: unknown) => void = () => undefined,
): QrCache {
  let queue: Promise<unknown> = Promise.resolve();
  let currentEpoch = 0;

  function serial<T>(task: () => Promise<T>, fallback: T): Promise<T> {
    const run = queue.then(task).catch((error: unknown) => {
      onError(error);
      return fallback;
    });
    queue = run;
    return run;
  }

  const readIndex = async (): Promise<string[]> => parseIndex(await store.getItem(INDEX_KEY));
  const writeIndex = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) await store.removeItem(INDEX_KEY);
    else await store.setItem(INDEX_KEY, JSON.stringify(ids));
  };

  async function removeNow(bookingId: string): Promise<void> {
    await store.removeItem(entryKey(bookingId));
    await writeIndex((await readIndex()).filter((id) => id !== bookingId));
  }

  return {
    epoch: () => currentEpoch,

    save: (bookingId, entry, epoch) =>
      serial(async () => {
        const valid =
          (epoch === undefined || epoch === currentEpoch) &&
          isUuid(bookingId) &&
          entry.token.length > 0 &&
          entry.token.length <= MAX_TOKEN_LENGTH &&
          ASCII_PRINTABLE.test(entry.token) &&
          entry.expiresAtMs > now();
        if (!valid) return false;
        const kept = (await readIndex()).filter((id) => id !== bookingId);
        const evicted = kept.slice(0, Math.max(0, kept.length - (MAX_ENTRIES - 1)));
        // Index (the intent) first, entry second: if the entry write fails, clearAll/prune still
        // know the id, so no unreachable token can stay behind.
        await writeIndex([...kept.slice(evicted.length), bookingId]);
        for (const id of evicted) await store.removeItem(entryKey(id));
        await store.setItem(entryKey(bookingId), JSON.stringify({ t: entry.token, e: entry.expiresAtMs }));
        return true;
      }, false),

    load: (bookingId) =>
      serial(async () => {
        if (!isUuid(bookingId)) return null;
        const entry = parseEntry(await store.getItem(entryKey(bookingId)));
        if (entry === null) return null;
        if (entry.expiresAtMs <= now()) {
          await removeNow(bookingId);
          return null;
        }
        return entry;
      }, null),

    remove: (bookingId) =>
      serial(async () => {
        if (isUuid(bookingId)) await removeNow(bookingId);
      }, undefined),

    prune: () =>
      serial(async () => {
        for (const id of await readIndex()) {
          const entry = parseEntry(await store.getItem(entryKey(id)));
          if (entry === null || entry.expiresAtMs <= now()) await removeNow(id);
        }
      }, undefined),

    clearAll: () => {
      currentEpoch += 1; // synchronously: saves queued behind this call are already refused
      return serial(async () => {
        for (const id of await readIndex()) await store.removeItem(entryKey(id));
        await store.removeItem(INDEX_KEY);
      }, undefined);
    },
  };
}

/**
 * Same trigger as the query-cache binding: when the session ends or another account signs in (or
 * the app starts without a session) every stored token is wiped. The auth store is untouched.
 */
export function bindQrCacheToSession(cache: Pick<QrCache, 'clearAll'>, session: SessionSource): () => void {
  return onSessionEnd(session, () => void cache.clearAll());
}
