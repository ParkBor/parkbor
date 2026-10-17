import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { AuthContext, type AuthState, defaultRefreshStore, type RefreshTokenStore } from './auth'
import { createSession, type SessionDeps, type SessionSnapshot } from './session'

interface AuthProviderProps {
  children: ReactNode
  store?: RefreshTokenStore
  deps?: SessionDeps
  /** A signed-in session ended (logout / refresh impossible): drop cached server data here. */
  onSessionCleared?: () => void
}

export function AuthProvider({ children, store = defaultRefreshStore, deps, onSessionCleared }: AuthProviderProps) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const [isRestoring, setIsRestoring] = useState(() => store.get() !== null)

  const session = useMemo(() => createSession({ store, deps, onChange: setSnapshot }), [store, deps])

  useEffect(() => {
    session.setOnCleared(onSessionCleared)
  }, [session, onSessionCleared])

  // Layout effect: the 401 hooks must exist before any child effect fires a request. Detaching
  // also silences this session if the provider is re-created with another store.
  useLayoutEffect(() => session.attach(), [session])

  useEffect(() => {
    void session
      .bootstrap()
      .catch(() => undefined)
      .finally(() => setIsRestoring(false)) // never stay "loading", whatever happened meanwhile
  }, [session])

  const retry = useCallback(() => {
    setSnapshot(null)
    setIsRestoring(true)
    void session
      .retry()
      .catch(() => undefined)
      .finally(() => setIsRestoring(false))
  }, [session])

  const value = useMemo<AuthState>(
    () => ({
      status: snapshot?.status ?? (isRestoring ? 'loading' : 'anonymous'),
      user: snapshot?.user ?? null,
      login: session.login,
      logout: session.logout,
      retry,
    }),
    [snapshot, isRestoring, session, retry],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
