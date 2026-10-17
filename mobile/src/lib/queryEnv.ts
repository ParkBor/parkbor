export interface NetworkSnapshot {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
}

type Subscribe<T> = (listener: (value: T) => void) => { remove: () => void };

/** Unknown (null/undefined) counts as online: only an explicit "no" blocks requests. */
export function isOnline(state: NetworkSnapshot): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

/** App foreground/background -> TanStack focus, so stale data refetches when the app returns. */
export function wireFocus(subscribe: Subscribe<string>, setFocused: (focused: boolean) => void): () => void {
  const subscription = subscribe((appState) => setFocused(appState === 'active'));
  return () => subscription.remove();
}

/** Connectivity changes -> TanStack online state (pauses/resumes queries instead of failing them). */
export function wireOnline(subscribe: Subscribe<NetworkSnapshot>, setOnline: (online: boolean) => void): () => void {
  const subscription = subscribe((state) => setOnline(isOnline(state)));
  return () => subscription.remove();
}
