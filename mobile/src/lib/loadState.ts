export type LoadState = 'ready' | 'loading' | 'offline' | 'error';

export interface LoadInput {
  hasData: boolean;
  isPending: boolean;
  isError: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
}

/**
 * Screen state of a query. `paused` with nothing loaded yet means "waiting for a connection":
 * shown as an offline state with a retry button instead of a spinner that never ends.
 */
export function loadState(input: LoadInput): LoadState {
  if (input.hasData) return 'ready';
  if (input.isPending && input.fetchStatus === 'paused') return 'offline';
  if (input.isPending) return 'loading';
  return input.isError ? 'error' : 'loading';
}
