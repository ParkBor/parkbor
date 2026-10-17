/** A refresh token whose server-side revocation is still owed. */
export interface PendingRevoke {
  token: string;
  /** Owner when known (logout); null when unknown (left from the offline screen). */
  userId: number | string | null;
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
    return Array.isArray(data) ? data.filter(isEntry).map(({ token, userId }) => ({ token, userId })) : [];
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
