import { authApi } from '@/lib/authApi';
import { getApiUrl } from '@/lib/config';
import { createHttp } from '@/lib/http';
import {
  securePendingClearStorage,
  securePendingRevokeStore,
  secureRefreshStorage,
} from '@/lib/secureRefreshStorage';
import { createAuthStore } from '@/store/createAuthStore';

/**
 * Composition root for the session: the auth store and the authenticated axios client
 * reference each other, so both are created here.
 */
export const authStore = createAuthStore({
  storage: secureRefreshStorage,
  pendingClear: securePendingClearStorage,
  pendingRevoke: securePendingRevokeStore,
  refreshCall: authApi.refresh,
  fetchMe: authApi.me,
  // Plain client with an explicit access token: logout may run after the local session is gone
  // (TODO(push): also send expo_push_token once /me/devices registration exists).
  serverLogout: (refresh, access) => authApi.logout(access, refresh),
});

export const api = createHttp({
  baseURL: getApiUrl(),
  getAccessToken: () => authStore.getState().accessToken,
  getSessionEpoch: () => authStore.getState().getEpoch(),
  refresher: { refresh: () => authStore.getState().refreshAccess() },
  // clearSession never rejects (see createAuthStore), so no unhandled rejection here.
  onSessionExpired: () => {
    void authStore.getState().clearSession();
  },
});
