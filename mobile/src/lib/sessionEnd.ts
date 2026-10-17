interface SessionSnapshot {
  status: string;
  user: { id: string | number } | null;
}

export interface SessionSource {
  getState: () => SessionSnapshot;
  subscribe: (listener: (state: SessionSnapshot) => void) => () => void;
}

function sessionKey(state: SessionSnapshot): string | null {
  return state.status === 'authenticated' ? String(state.user?.id ?? '') : null;
}

/**
 * Calls `callback` when the session ends (logout, expiry), another account signs in, or the app
 * starts/settles without any session (leftovers of a killed logout). Subscribes from the outside;
 * the auth store is untouched. Returns the unsubscribe function.
 */
export function onSessionEnd(session: SessionSource, callback: () => void): () => void {
  let previous = sessionKey(session.getState());
  return session.subscribe((state) => {
    const next = sessionKey(state);
    const ended = previous !== null && next !== previous;
    const noSession = next === null && state.status === 'anonymous';
    previous = next;
    if (ended || noSession) callback();
  });
}
