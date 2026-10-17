interface SessionSnapshot {
  status: string;
  user: { id: string | number } | null;
}

interface SessionSource {
  getState: () => SessionSnapshot;
  subscribe: (listener: (state: SessionSnapshot) => void) => () => void;
}

interface Clearable {
  cancelQueries: () => Promise<unknown>;
  clear: () => void;
}

function sessionKey(state: SessionSnapshot): string | null {
  return state.status === 'authenticated' ? String(state.user?.id ?? '') : null;
}

/**
 * Responses behind auth live in the query cache. When the session ends - or another account
 * signs in - in-flight requests are cancelled and the cache is emptied, so nothing of the
 * previous user can be shown to (or refetched for) the next one. Returns the unsubscribe function.
 */
export function bindQueryClientToSession(client: Clearable, session: SessionSource): () => void {
  let previous = sessionKey(session.getState());
  return session.subscribe((state) => {
    const next = sessionKey(state);
    if (previous !== null && next !== previous) {
      void client.cancelQueries();
      client.clear();
    }
    previous = next;
  });
}
