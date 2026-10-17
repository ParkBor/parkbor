import { create as createAxios, type AxiosInstance } from 'axios';

import { getApiUrl } from '@/lib/config';
import { attachErrorSanitizer, REQUEST_TIMEOUT_MS } from '@/lib/http';
import type {
  AuthResult,
  LoginStatusResponse,
  RefreshResponse,
  StartLoginResponse,
  User,
} from '@/lib/types';

export function createAuthApi(client: AxiosInstance) {
  return {
    async start(deviceId: string): Promise<StartLoginResponse> {
      const res = await client.post<StartLoginResponse>('/auth/telegram/start', { device_id: deviceId });
      return res.data;
    },
    async status(loginToken: string): Promise<LoginStatusResponse> {
      const res = await client.get<LoginStatusResponse>('/auth/telegram/status', {
        params: { login_token: loginToken },
      });
      return res.data;
    },
    async verify(loginToken: string, code: string): Promise<AuthResult> {
      const res = await client.post<AuthResult>('/auth/telegram/verify', {
        login_token: loginToken,
        code,
      });
      return res.data;
    },
    async refresh(refreshToken: string): Promise<RefreshResponse> {
      const res = await client.post<RefreshResponse>('/auth/token/refresh', { refresh: refreshToken });
      return res.data;
    },
    /** Revokes a refresh token. Authenticated; sent with an explicit access token (no interceptors). */
    async logout(accessToken: string, refreshToken: string): Promise<void> {
      await client.post(
        '/auth/logout',
        { refresh: refreshToken },
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
    },
    async me(accessToken: string): Promise<User> {
      const res = await client.get<User>('/me', { headers: { Authorization: `Bearer ${accessToken}` } });
      return res.data;
    },
  };
}

// Plain client WITHOUT the refresh interceptor: used by the login flow and by the
// refresh call itself (an interceptor here would recurse). Errors are sanitized so
// codes, tokens and Authorization headers never travel inside thrown errors.
const raw = createAxios({
  baseURL: getApiUrl(),
  timeout: REQUEST_TIMEOUT_MS,
  allowAbsoluteUrls: false,
  headers: { Accept: 'application/json' },
});
attachErrorSanitizer(raw);

export const authApi = createAuthApi(raw);
