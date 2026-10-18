// What to do after the socket closed (ARCHITECTURE 12.0, close-code table).
export type CloseAction =
  /** App bug (bad frame / too big): reconnecting would repeat it. Stay down for this session. */
  | 'fatal'
  /** Another connection replaced this one: reconnecting would start a tug-of-war between devices. */
  | 'replaced'
  /** Rate limit: slow down; at least 30 s before the next attempt. */
  | 'rate_limited'
  /** Ticket refused: refresh the token once, then take a new ticket. */
  | 'auth'
  /** Maximum age reached: reconnect right away with a new ticket and resubscribe. */
  | 'immediate'
  /** Idle timeout, server error, ticket store down, network drop, anything unknown. */
  | 'backoff';

export function classifyClose(code: number | undefined): CloseAction {
  switch (code) {
    case 4400:
    case 1009:
      return 'fatal';
    case 4409:
      return 'replaced';
    case 4429:
      return 'rate_limited';
    case 4401:
      return 'auth';
    case 4410:
      return 'immediate';
    default:
      return 'backoff';
  }
}
