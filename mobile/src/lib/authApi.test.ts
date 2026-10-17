import {
  AxiosError,
  create as createAxios,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { createAuthApi } from '@/lib/authApi';
import { attachErrorSanitizer } from '@/lib/http';

vi.mock('@/lib/config', () => ({ getApiUrl: () => 'http://api.test' }));


interface Seen {
  method?: string;
  url?: string;
  data?: unknown;
  params?: unknown;
  auth?: unknown;
}

function setup(status = 200, body: unknown = {}) {
  const seen: Seen[] = [];
  const adapter = (async (config: InternalAxiosRequestConfig) => {
    seen.push({
      method: config.method,
      url: config.url,
      data: config.data ? JSON.parse(config.data as string) : undefined,
      params: config.params,
      auth: config.headers.get('Authorization'),
    });
    const res = { data: body, status, statusText: '', headers: {}, config } as AxiosResponse;
    if (status < 300) return res;
    throw new AxiosError('failed', String(status), config, {}, res);
  }) as AxiosAdapter;
  const client = createAxios({ baseURL: 'http://api.test', adapter });
  attachErrorSanitizer(client); // same as the production client in authApi.ts
  return { api: createAuthApi(client), seen };
}

describe('createAuthApi', () => {
  it('start posts the device id', async () => {
    const { api, seen } = setup(200, { login_token: 't', bot_url: 'u', expires_in: 300 });
    await expect(api.start('dev-1')).resolves.toMatchObject({ expires_in: 300 });
    expect(seen[0]).toMatchObject({ method: 'post', url: '/auth/telegram/start', data: { device_id: 'dev-1' } });
  });

  it('status sends the token as a query parameter', async () => {
    const { api, seen } = setup(200, { status: 'PENDING', needs_code: false });
    await api.status('tok');
    expect(seen[0]).toMatchObject({ method: 'get', url: '/auth/telegram/status', params: { login_token: 'tok' } });
  });

  it('verify posts token and code', async () => {
    const { api, seen } = setup(200, { access: 'a' });
    await api.verify('tok', '123456');
    expect(seen[0]).toMatchObject({
      url: '/auth/telegram/verify',
      data: { login_token: 'tok', code: '123456' },
    });
  });

  it('refresh posts the refresh token without any Authorization header', async () => {
    const { api, seen } = setup(200, { access: 'a', refresh: 'r' });
    await expect(api.refresh('old')).resolves.toEqual({ access: 'a', refresh: 'r' });
    expect(seen[0]).toMatchObject({ url: '/auth/token/refresh', data: { refresh: 'old' } });
    expect(seen[0]?.auth).toBeUndefined();
  });

  it('me sends the given access token explicitly', async () => {
    const { api, seen } = setup(200, { id: 1 });
    await api.me('access-1');
    expect(seen[0]).toMatchObject({ url: '/me', auth: 'Bearer access-1' });
  });

  it('logout posts the refresh token with an explicit Bearer access token', async () => {
    const { api, seen } = setup(204);
    await api.logout('access-1', 'refresh-1');
    expect(seen[0]).toMatchObject({
      method: 'post',
      url: '/auth/logout',
      data: { refresh: 'refresh-1' },
      auth: 'Bearer access-1',
    });
  });

  it('logout failures carry neither token', async () => {
    const { api } = setup(401);
    const error = (await api.logout('access-secret', 'refresh-secret').catch((e: unknown) => e)) as AxiosError;
    const dumped = JSON.stringify(error.toJSON()) + JSON.stringify(error.config);
    expect(dumped).not.toContain('access-secret');
    expect(dumped).not.toContain('refresh-secret');
  });

  it('strips code, token and Authorization from failures', async () => {
    const { api } = setup(400, { detail: 'x', code: 'invalid_code' });
    const error = (await api.verify('tok-secret', '123456').catch((e: unknown) => e)) as AxiosError;
    expect(error.config?.data).toBeUndefined();
    expect(JSON.stringify(error.toJSON())).not.toContain('123456');
    expect(JSON.stringify(error.toJSON())).not.toContain('tok-secret');
  });

  it('strips the access token from /me failures', async () => {
    const { api } = setup(500);
    const error = (await api.me('access-secret').catch((e: unknown) => e)) as AxiosError;
    expect(JSON.stringify(error.toJSON())).not.toContain('access-secret');
  });
});
