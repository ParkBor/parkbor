import type { SlotType } from '@/features/map/schemas';
import type { PaymentProvider } from '@/features/payment/providerChoice';
import { onSessionEnd, type SessionSource } from '@/lib/sessionEnd';

/** Server format: 8-128 characters of [A-Za-z0-9_.:-]. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

const MINUTE_MS = 60_000;

export interface CreateBookingPayload {
  parkingLotId: string;
  slotType: SlotType;
  vehicleId: string;
  startMs: number;
  endMs: number;
  preferredSlotId: string | null;
  /**
   * Chosen checkout; null = the server default. Part of the server's request fingerprint. The client
   * treats null (default) and an explicit provider as two different attempts even when the server
   * default happens to be that provider: a new Idempotency-Key is always safe, a reused one is not.
   */
  paymentProvider: PaymentProvider | null;
}

/** cyrb53: a fast 53-bit string hash. Opaque on purpose - never log or send it. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * Identity of "the same booking attempt". Mirrors how the server fingerprints a body: whole minutes
 * (seconds are dropped), independent of the time zone the instants were written in.
 */
export function bookingFingerprint(payload: CreateBookingPayload): string {
  return hash53(
    [
      payload.parkingLotId,
      payload.slotType,
      payload.vehicleId,
      Math.floor(payload.startMs / MINUTE_MS),
      Math.floor(payload.endMs / MINUTE_MS),
      payload.preferredSlotId ?? '',
      payload.paymentProvider ?? '',
    ].join('|'),
  );
}

export interface IdempotencyKeeper {
  /** Same fingerprint -> the same key as long as the attempt is unresolved; a new fingerprint -> a new key. */
  keyFor(fingerprint: string): string;
  /** The attempt succeeded: the next booking (even an identical one) is a new attempt. */
  release(): void;
  /** Force a fresh key for the same payload (the server refused the old one). */
  rotate(): void;
}

/**
 * One key per attempt. Double taps and retries after a network error reuse the key, so the server
 * can answer with the original booking instead of creating a second one; a changed payload must
 * never reuse a key (the server would answer 422 idempotency_conflict).
 */
export function createIdempotencyKeeper(generate: () => string): IdempotencyKeeper {
  let current: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(fingerprint) {
      if (current !== null && current.fingerprint === fingerprint) return current.key;
      const key = generate();
      if (!IDEMPOTENCY_KEY_PATTERN.test(key)) throw new RangeError('Generated idempotency key has an invalid format');
      current = { fingerprint, key };
      return key;
    },
    release() {
      current = null;
    },
    rotate() {
      current = null;
    },
  };
}

/**
 * The app-wide keeper lives in module memory (never on disk): closing and reopening the booking
 * modal after a lost response keeps the key of the unresolved attempt, so the server can answer
 * with the original booking. A finished session must not leak its key to the next account.
 */
export function bindKeeperToSession(keeper: Pick<IdempotencyKeeper, 'rotate'>, session: SessionSource): () => void {
  return onSessionEnd(session, () => keeper.rotate());
}
