/** A rejected group is retried once, after the server's negative cache (30 s) has expired. */
export const REJECT_RETRY_MS = 31_000;
export const MAX_REJECT_RETRIES = 1;

export type RejectAction = { type: 'retry'; afterMs: number } | { type: 'give_up' };

/**
 * `rejected[].code` from `subscribed` (or a server-initiated `unsubscribed`, treated as
 * `not_found`): malformed groups and the group cap never succeed by repeating; "not found" can
 * (a lot becoming ACTIVE, an operator assignment) so it gets one late retry, then the group is
 * left alone until the next connection.
 */
export function rejectAction(code: string, retriesSoFar: number): RejectAction {
  if (code !== 'not_found' || retriesSoFar >= MAX_REJECT_RETRIES) return { type: 'give_up' };
  return { type: 'retry', afterMs: REJECT_RETRY_MS };
}
