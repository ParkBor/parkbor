/**
 * Leaf module (imported by lib/api.ts, which must not import the push runtime): the Expo push
 * token this device holds right now. The auth store reads it when a session is about to end and
 * queues it with the refresh-token revocation (POST /auth/logout), so the server unregisters
 * exactly this device - also on a retry after the app was killed or offline.
 */
let current: string | null = null;

export const currentPushToken = {
  set(token: string | null): void {
    current = token;
  },
  get(): string | null {
    return current;
  },
};
