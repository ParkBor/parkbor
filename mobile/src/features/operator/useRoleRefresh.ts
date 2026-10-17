import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { roleRefreshDue } from '@/features/operator/pollingPolicy';
import { nextUserForRole } from '@/features/operator/tabVisibility';
import { api } from '@/lib/api';
import { authStore, useAuthStore } from '@/store/auth';

/**
 * Re-reads /me when the tabs are shown and when the app returns to the foreground (at most once a
 * minute), so a role change made elsewhere (invite accepted, assignment removed) updates the tab
 * bar. Only the role is applied; the auth store itself is untouched (setUser is its public API).
 * The tab is a convenience - the backend checks the role on every request.
 */
export function useRoleRefresh(): void {
  const isAuthenticated = useAuthStore((state) => state.status === 'authenticated');
  const lastAtMs = useRef<number | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) return undefined;

    async function refresh(): Promise<void> {
      const nowMs = Date.now();
      if (inFlight.current || !roleRefreshDue({ lastAtMs: lastAtMs.current, nowMs })) return;
      inFlight.current = true;
      const epoch = authStore.getState().getEpoch();
      try {
        const response = await api.get<unknown>('/me');
        lastAtMs.current = nowMs;
        const next = nextUserForRole(authStore.getState().user, response.data);
        if (next) await authStore.getState().setUser(next, epoch);
      } catch {
        // Offline or refused: keep the current role; the next foreground tries again.
      } finally {
        inFlight.current = false;
      }
    }

    void refresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [isAuthenticated]);
}
