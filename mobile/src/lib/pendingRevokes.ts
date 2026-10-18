/** A refresh token whose server-side revocation is still owed. */
export interface PendingRevoke {
  token: string;
  /** Owner when known (logout); null when unknown (left from the offline screen). */
  userId: number | string | null;
  /**
   * Expo push token of this device while the account was signed in. It travels with the logout so
   * the server unregisters the device; it lives in the same secure storage as the refresh token.
   */
  pushToken?: string;
}

const MAX_PUSH_TOKEN_LENGTH = 200;

function validPushToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PUSH_TOKEN_LENGTH;
}

/** Bounded: SecureStore values should stay under ~2 KB (a refresh JWT is ~350 bytes). */
export const MAX_PENDING_REVOKES = 4;

/** Async persistence of the pending list (secure storage in the app). */
export interface PendingRevokeStore {
  read(): Promise<PendingRevoke[]>;
  write(list: readonly PendingRevoke[]): Promise<void>;
}

function isEntry(value: unknown): value is PendingRevoke {
  if (typeof value !== 'object' || value === null) return false;
  const { token, userId } = value as Record<string, unknown>;
  return (
    typeof token === 'string' &&
    token.length > 0 &&
    (userId === null || typeof userId === 'string' || typeof userId === 'number')
  );
}

export function parsePending(raw: string | null): PendingRevoke[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(isEntry).map((entry) => {
      const { token, userId } = entry;
      const pushToken: unknown = (entry as { pushToken?: unknown }).pushToken;
      return validPushToken(pushToken) ? { token, userId, pushToken } : { token, userId };
    });
  } catch {
    return [];
  }
}

export function serializePending(list: readonly PendingRevoke[]): string {
  return JSON.stringify(list);
}

export function addPending(
  list: readonly PendingRevoke[],
  entry: PendingRevoke,
  onDrop?: (dropped: number) => void,
): PendingRevoke[] {
  const next = [...list.filter((x) => x.token !== entry.token), entry];
  const dropped = Math.max(0, next.length - MAX_PENDING_REVOKES);
  if (dropped > 0) onDrop?.(dropped);
  return next.slice(-MAX_PENDING_REVOKES);
}

export function removePending(list: readonly PendingRevoke[], token: string): PendingRevoke[] {
  return list.filter((x) => x.token !== token);
}
