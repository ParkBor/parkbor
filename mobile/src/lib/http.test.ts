import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { createHttp, isPublicPath, sanitizeAxiosError } from '@/lib/http';
import { SessionExpiredError } from '@/lib/refresh';

/** Every string reachable from a value (own enumerable props, cycle-safe) - a poor man's util.inspect. */
function inspect(value: unknown, _opts?: unknown): string {
  const seen = new Set<unknown>();
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'object' && v !== null && !seen.has(v)) {
      seen.add(v);
      for (const [k, child] of Object.entries(v)) {
        out.push(k);
        walk(child);
      }
    }
  };
  walk(value);
  return out.join(' | ');
}

type Handler = (config: InternalAxiosRequestConfig, auth: string | undefined) => number;

// Shaped like React Native's XHR object: it keeps the request headers and the full URL.
const REQUEST_STUB = {
  _headers: { authorization: 'Bearer old', accept: 'application/json' },
  _url: 'http://api.test/auth/telegram/status?login_token=LOGIN-SECRET-123',
  responseURL: 'http://api.test/auth/telegram/status?login_token=LOGIN-SECRET-123',
};

function reply(config: InternalAxiosRequestConfig, status: number): AxiosResponse {
  const res = { data: {}, status, statusText: '', headers: {}, config, request: REQUEST_STUB } as AxiosResponse;
  if (status < 300) return res;
  throw new AxiosError('failed', String(status), config, REQUEST_STUB, res);
}

function setup(handler: Handler, refreshImpl?: () => Promise<string>) {
  let access: string | null = 'old';
  const calls: string[] = [];
  const adapter = (async (config: InternalAxiosRequestConfig) => {
    const auth = config.headers.get('Authorization') as string | undefined;
    calls.push(`${config.method?.toUpperCase()} ${config.url} ${auth ?? '-'}`);
    return reply(config, handler(config, auth));
  }) as AxiosAdapter;
  const refresh = vi.fn(
    refreshImpl ??
      (async () => {
        access = 'fresh';
        return 'fresh';
      }),
  );
  const onSessionExpired = vi.fn();
  const epoch = { value: 1 };
  const http = createHttp({
    baseURL: 'http://api.test',
    getAccessToken: () => access,
    getSessionEpoch: () => epoch.value,
    refresher: { refresh },
    onSessionExpired,
    adapter,
  });
  return { http, calls, refresh, onSessionExpired, epoch, setAccess: (t: string | null) => (access = t) };
}

const rejectExpired = async (): Promise<string> => {
  throw new SessionExpiredError();
};

describe('createHttp', () => {
  it('attaches the in-memory access token', async () => {
    const { http, calls } = setup(() => 200);
    await http.get('/me');
    expect(calls).toEqual(['GET /me Bearer old']);
  });

  it('omits Authorization when there is no token', async () => {
    const { http, calls, setAccess } = setup(() => 200);
    setAccess(null);
    await http.get('/me');
    expect(calls).toEqual(['GET /me -']);
  });

  it('on 401 refreshes once and retries with the new token', async () => {
    const { http, calls, refresh } = setup((_c, auth) => (auth === 'Bearer fresh' ? 200 : 401));
    const res = await http.get('/me');
    expect(res.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['GET /me Bearer old', 'GET /me Bearer fresh']);
  });

  it('single-flights refresh for parallel 401s', async () => {
    const { http, refresh, calls } = setup((_c, auth) => (auth === 'Bearer fresh' ? 200 : 401));
    const results = await Promise.all([http.get('/a'), http.get('/b'), http.get('/c')]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.endsWith('Bearer fresh'))).toHaveLength(3);
  });

  it('does not refresh again when a late 401 arrives after the token was already rotated', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let access: string | null = 'old';
    const refresh = vi.fn(async () => {
      access = 'fresh';
      return 'fresh';
    });
    const adapter = (async (config: InternalAxiosRequestConfig) => {
      const auth = config.headers.get('Authorization');
      if (config.url === '/slow' && auth === 'Bearer old') await gate;
      return reply(config, auth === 'Bearer fresh' ? 200 : 401);
    }) as AxiosAdapter;
    const http = createHttp({
      baseURL: 'http://api.test',
      getAccessToken: () => access,
      getSessionEpoch: () => 1,
      refresher: { refresh },
      onSessionExpired: vi.fn(),
      adapter,
    });

    const slow = http.get('/slow');
    await http.get('/fast'); // 401 -> refresh -> retry ok
    release();
    await expect(slow).resolves.toMatchObject({ status: 200 });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not loop: a second 401 after retry is surfaced', async () => {
    const { http, refresh } = setup(() => 401);
    await expect(http.get('/me')).rejects.toMatchObject({ response: { status: 401 } });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('when refresh is rejected, signals session expiry and rejects with the original 401', async () => {
    const { http, onSessionExpired } = setup(() => 401, rejectExpired);
    await expect(http.get('/me')).rejects.toMatchObject({ response: { status: 401 } });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('parallel requests with a rejected refresh expire the session once', async () => {
    // The real refresher is single-flight, so concurrent callers see the same rejection.
    const shared = rejectExpired();
    shared.catch(() => undefined);
    const { http, onSessionExpired, refresh } = setup(() => 401, () => shared);
    await Promise.allSettled([http.get('/a'), http.get('/b')]);
    expect(refresh).toHaveBeenCalled();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('keeps the session on a transient refresh failure', async () => {
    const { http, onSessionExpired } = setup(
      () => 401,
      async () => {
        throw new AxiosError('Network Error', 'ERR_NETWORK');
      },
    );
    await expect(http.get('/me')).rejects.toBeDefined();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it.each(['/auth/telegram/start', '/auth/telegram/status', '/auth/telegram/verify', '/auth/token/refresh'])(
    'sends no Bearer and never refreshes for public endpoint %s',
    async (url) => {
      const { http, refresh, calls } = setup(() => 401);
      await expect(http.post(url, {})).rejects.toBeDefined();
      expect(refresh).not.toHaveBeenCalled();
      expect(calls).toEqual([`POST ${url} -`]);
    },
  );

  it('logout carries the Bearer token (it is an authenticated endpoint)', async () => {
    const { http, calls } = setup(() => 204);
    await http.post('/auth/logout', { refresh: 'r' });
    expect(calls).toEqual(['POST /auth/logout Bearer old']);
  });

  it('logout refreshes on 401 and retries with the new Bearer token', async () => {
    const { http, calls, refresh } = setup((_c, auth) => (auth === 'Bearer fresh' ? 204 : 401));
    const res = await http.post('/auth/logout', { refresh: 'r' });
    expect(res.status).toBe(204);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['POST /auth/logout Bearer old', 'POST /auth/logout Bearer fresh']);
  });

  it('does not treat lookalike paths as public', async () => {
    const { http, calls } = setup(() => 200);
    await http.get('/auth/telegram-evil');
    await http.get('/auth/token/refreshx');
    expect(calls.every((c) => c.endsWith('Bearer old'))).toBe(true);
  });

  it('refuses absolute URLs so the token cannot be sent to another host', async () => {
    const { http, calls } = setup(() => 200);
    await http.get('https://evil.example/steal');
    // allowAbsoluteUrls=false: an absolute URL is appended to baseURL, never used as the target
    expect(http.defaults.allowAbsoluteUrls).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('retries with its own headers object (not shared with the failed request)', async () => {
    const seen: unknown[] = [];
    const { http } = setup((c, auth) => {
      seen.push(c.headers);
      return auth === 'Bearer fresh' ? 200 : 401;
    });
    await http.get('/me');
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('strips credentials and payload from errors that reach callers', async () => {
    const { http } = setup(() => 400);
    const err = (await http
      .post('/me', { secret: 'payload' }, { params: { login_token: 'tok' } })
      .catch((e: unknown) => e)) as AxiosError;
    expect(err.config?.headers.get('Authorization')).toBeUndefined();
    expect(err.config?.data).toBeUndefined();
    expect(err.config?.params).toBeUndefined();
    const dumped = JSON.stringify(err.toJSON()) + inspect(err, { depth: 8 });
    for (const secret of ['Bearer', 'payload', 'LOGIN-SECRET-123', 'authorization']) {
      expect(dumped.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it('never leaves the bare access token anywhere on the error (not just "Bearer ...")', async () => {
    const { http, setAccess } = setup(() => 500);
    setAccess('SUPER-SECRET-ACCESS');
    const err = (await http.get('/me').catch((e: unknown) => e)) as AxiosError;
    expect(inspect(err, { depth: 10 })).not.toContain('SUPER-SECRET-ACCESS');
    expect(JSON.stringify(err.config)).not.toContain('SUPER-SECRET-ACCESS');
    expect(err.request).toBeUndefined();
    expect(err.response?.request).toBeUndefined();
  });

  it('strips credentials even when headers are a plain object', () => {
    const error = new AxiosError('x', '400', undefined, undefined, undefined);
    error.config = { headers: { Authorization: 'Bearer plain', authorization: 'Bearer plain2', Accept: 'a' } } as never;
    sanitizeAxiosError(error);
    expect(JSON.stringify(error.config)).not.toContain('plain');
    expect((error.config as unknown as { headers: Record<string, string> }).headers.Accept).toBe('a');
  });

  it('also strips the Idempotency-Key header (a replay token for a booking must not reach logs)', () => {
    const error = new AxiosError('x', '400', undefined, undefined, undefined);
    error.config = { headers: { 'Idempotency-Key': 'key-abc12345', accept: 'a' } } as never;
    sanitizeAxiosError(error);
    expect(JSON.stringify(error.config)).not.toContain('key-abc12345');
    expect(JSON.stringify(error.config)).toContain('a');
  });

  it('does not retry on 401 when the session changed meanwhile (no replay with another account)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    let access: string | null = 'tokenA';
    const epoch = { value: 1 };
    const refresh = vi.fn(async () => 'fresh');
    const adapter = (async (config: InternalAxiosRequestConfig) => {
      calls.push(`${config.method} ${config.url} ${String(config.headers.get('Authorization'))}`);
      if (calls.length === 1) await gate;
      return reply(config, 401);
    }) as AxiosAdapter;
    const http = createHttp({
      baseURL: 'http://api.test',
      getAccessToken: () => access,
      getSessionEpoch: () => epoch.value,
      refresher: { refresh },
      onSessionExpired: vi.fn(),
      adapter,
    });

    const inFlight = http.post('/payments', { amount: 1 }).catch((e: unknown) => e);
    await Promise.resolve();
    access = 'tokenB'; // another account signed in
    epoch.value = 2;
    release();

    expect((await inFlight) as AxiosError).toMatchObject({ response: { status: 401 } });
    expect(calls).toEqual(['post /payments Bearer tokenA']);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    '/auth/telegram/../me',
    '/auth/telegram/%2e%2e/me',
    '/auth/telegram/%2E%2E/me',
    '/auth/telegram//x',
    '//auth/token/refresh',
    '/auth/telegram/..%2fme',
    '/auth/telegram/a%2fb',
    String.raw`/auth/telegram\x`,
    '/auth/telegram/',
  ])('does not treat the traversal-ish path %s as public', (url) => {
    expect(isPublicPath(url)).toBe(false);
  });

  it('still recognises the real public paths (with a query string)', () => {
    expect(isPublicPath('/auth/telegram/status?login_token=abc')).toBe(true);
    expect(isPublicPath('/auth/token/refresh')).toBe(true);
    expect(isPublicPath(undefined)).toBe(false);
  });

  it('passes through non-401 errors untouched', async () => {
    const { http, refresh } = setup(() => 500);
    await expect(http.get('/me')).rejects.toMatchObject({ response: { status: 500 } });
    expect(refresh).not.toHaveBeenCalled();
  });
});
