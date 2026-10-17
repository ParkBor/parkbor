import { AxiosError, type AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { createLoginStore } from '@/features/auth/createLoginStore';
import type { AuthResult, User } from '@/lib/types';

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_-abc';
const BOT_URL = `https://t.me/HabiParkingBot?start=${TOKEN}`;
const NOW = 1_700_000_000_000;

const USER: User = {
  id: 1,
  telegram_id: 99,
  telegram_username: 'ali',
  phone: '+998901234567',
  first_name: '',
  last_name: '',
  language: 'uz',
  role: 'DRIVER',
  tg_notifications: true,
};
const AUTH: AuthResult = { access: 'A', refresh: 'R', user: USER, is_new: true };

function httpError(status: number, code?: string): AxiosError {
  const response = {
    status,
    data: code ? { detail: 'x', code } : {},
    statusText: '',
    headers: {},
    config: {},
  } as AxiosResponse;
  return new AxiosError('failed', String(status), undefined, {}, response);
}

function setup(nowRef = { value: NOW }) {
  const api = {
    start: vi.fn().mockResolvedValue({ login_token: TOKEN, bot_url: BOT_URL, expires_in: 300 }),
    status: vi.fn().mockResolvedValue({ status: 'PENDING', needs_code: false }),
    verify: vi.fn().mockResolvedValue(AUTH),
  };
  const openUrl = vi.fn().mockResolvedValue(undefined);
  const onAuthenticated = vi.fn().mockResolvedValue(undefined);
  const store = createLoginStore({
    api,
    openUrl,
    getDeviceId: async () => 'device-1',
    botName: 'HabiParkingBot',
    onAuthenticated,
    now: () => nowRef.value,
  });
  return { store, api, openUrl, onAuthenticated, nowRef };
}

async function started() {
  const ctx = setup();
  await ctx.store.getState().start();
  return ctx;
}

describe('login store: start', () => {
  it('requests a token with the device id, opens the bot link and tracks expiry', async () => {
    const { store, api, openUrl } = setup();
    const result = await store.getState().start();

    expect(result.ok).toBe(true);
    expect(api.start).toHaveBeenCalledWith('device-1');
    expect(openUrl).toHaveBeenCalledWith(BOT_URL);
    expect(store.getState().session).toEqual({
      loginToken: TOKEN,
      botUrl: BOT_URL,
      expiresAt: NOW + 300_000,
    });
  });

  it('refuses a malformed login_token and opens nothing', async () => {
    const { store, api, openUrl } = setup();
    api.start.mockResolvedValue({ login_token: 'bad token!', bot_url: BOT_URL, expires_in: 300 });
    const result = await store.getState().start();
    expect(result).toMatchObject({ ok: false, errorKey: 'errors.generic' });
    expect(openUrl).not.toHaveBeenCalled();
    expect(store.getState().session).toBeNull();
  });

  it.each(['https://evil.com/HabiParkingBot?start=' + TOKEN, 'javascript:alert(1)', 'http://t.me/x'])(
    'refuses an untrusted bot_url %s',
    async (botUrl) => {
      const { store, api, openUrl } = setup();
      api.start.mockResolvedValue({ login_token: TOKEN, bot_url: botUrl, expires_in: 300 });
      const result = await store.getState().start();
      expect(result.ok).toBe(false);
      expect(openUrl).not.toHaveBeenCalled();
    },
  );

  it('refuses a deep link to a different bot, accepts the expected bot case-insensitively', async () => {
    const { store, api, openUrl } = setup();
    api.start.mockResolvedValueOnce({
      login_token: TOKEN,
      bot_url: `https://t.me/EvilBot?start=${TOKEN}`,
      expires_in: 300,
    });
    expect((await store.getState().start()).ok).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();

    api.start.mockResolvedValueOnce({
      login_token: TOKEN,
      bot_url: `https://t.me/habiparkingbot?start=${TOKEN}`,
      expires_in: 300,
    });
    expect((await store.getState().start()).ok).toBe(true);
  });

  it('refuses an absurd expires_in', async () => {
    const { store, api } = setup();
    api.start.mockResolvedValue({ login_token: TOKEN, bot_url: BOT_URL, expires_in: -1 });
    expect((await store.getState().start()).ok).toBe(false);
  });

  it('maps network failure and throttling to their messages', async () => {
    const { store, api } = setup();
    api.start.mockRejectedValueOnce(new AxiosError('Network Error', 'ERR_NETWORK'));
    expect(await store.getState().start()).toMatchObject({ ok: false, errorKey: 'errors.network' });
    api.start.mockRejectedValueOnce(httpError(429));
    expect(await store.getState().start()).toMatchObject({ ok: false, errorKey: 'errors.throttled' });
  });

  it('reports when Telegram cannot be opened but keeps the session for retry', async () => {
    const { store, openUrl } = setup();
    openUrl.mockRejectedValue(new Error('no handler'));
    const result = await store.getState().start();
    expect(result).toMatchObject({ ok: false, errorKey: 'errors.cannotOpenTelegram' });
    expect(store.getState().session?.loginToken).toBe(TOKEN);
  });
});

describe('login store: reopenBot', () => {
  it('opens the stored bot link again', async () => {
    const { store, openUrl } = await started();
    openUrl.mockClear();
    expect((await store.getState().reopenBot()).ok).toBe(true);
    expect(openUrl).toHaveBeenCalledWith(BOT_URL);
  });

  it('fails without a session', async () => {
    const { store, openUrl } = setup();
    expect((await store.getState().reopenBot()).ok).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('login store: checkStatus', () => {
  it('returns PENDING without changing the session', async () => {
    const { store, api } = await started();
    const result = await store.getState().checkStatus();
    expect(result).toEqual({ ok: true, value: 'PENDING' });
    expect(api.status).toHaveBeenCalledWith(TOKEN);
    expect(store.getState().session).not.toBeNull();
  });

  it('marks the session confirmed when the bot confirmed', async () => {
    const { store, api } = await started();
    api.status.mockResolvedValue({ status: 'CONFIRMED', needs_code: true });
    expect(await store.getState().checkStatus()).toEqual({ ok: true, value: 'CONFIRMED' });
    expect(store.getState().isConfirmed).toBe(true);
  });

  it('drops the session when the server says EXPIRED', async () => {
    const { store, api } = await started();
    api.status.mockResolvedValue({ status: 'EXPIRED', needs_code: false });
    expect(await store.getState().checkStatus()).toEqual({ ok: true, value: 'EXPIRED' });
    expect(store.getState().session).toBeNull();
  });

  it('rejects an unexpected status value', async () => {
    const { store, api } = await started();
    api.status.mockResolvedValue({ status: 'WHATEVER', needs_code: false });
    expect((await store.getState().checkStatus()).ok).toBe(false);
  });

  it('does not call the API without a session', async () => {
    const { store, api } = setup();
    expect((await store.getState().checkStatus()).ok).toBe(false);
    expect(api.status).not.toHaveBeenCalled();
  });

  it('surfaces network errors without dropping the session', async () => {
    const { store, api } = await started();
    api.status.mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK'));
    expect(await store.getState().checkStatus()).toMatchObject({ ok: false, errorKey: 'errors.network' });
    expect(store.getState().session).not.toBeNull();
  });
});

describe('login store: submitCode', () => {
  it('validates the code locally before any request', async () => {
    const { store, api } = await started();
    const result = await store.getState().submitCode('12345');
    expect(result).toMatchObject({ ok: false, errorKey: 'validation.codeInvalid' });
    expect(api.verify).not.toHaveBeenCalled();
  });

  it('verifies, hands the tokens to the auth layer and clears the session', async () => {
    const { store, api, onAuthenticated } = await started();
    const result = await store.getState().submitCode('482913');

    expect(api.verify).toHaveBeenCalledWith(TOKEN, '482913');
    expect(onAuthenticated).toHaveBeenCalledWith(AUTH);
    expect(result).toEqual({ ok: true, value: { isNew: true } });
    expect(store.getState().session).toBeNull();
  });

  it('counts wrong codes and keeps the session until the limit', async () => {
    const { store, api } = await started();
    api.verify.mockRejectedValue(httpError(400, 'invalid_code'));

    for (let i = 1; i <= 4; i++) {
      const r = await store.getState().submitCode('000000');
      expect(r).toMatchObject({ ok: false, errorKey: 'errors.invalidCode', fatal: false });
      expect(store.getState().failedAttempts).toBe(i);
    }
    expect(store.getState().session).not.toBeNull();
  });

  it('ends the session on the 5th wrong code (attempts exhausted)', async () => {
    const { store, api } = await started();
    api.verify.mockRejectedValue(httpError(400, 'invalid_code'));
    for (let i = 0; i < 4; i++) await store.getState().submitCode('000000');

    const r = await store.getState().submitCode('000000');
    expect(r).toMatchObject({ ok: false, errorKey: 'errors.attemptsExhausted', fatal: true });
    expect(store.getState().session).toBeNull();
  });

  it('treats 410 as an expired session', async () => {
    const { store, api } = await started();
    api.verify.mockRejectedValue(httpError(410, 'login_expired'));
    const r = await store.getState().submitCode('482913');
    expect(r).toMatchObject({ ok: false, errorKey: 'errors.codeExpired', fatal: true });
    expect(store.getState().session).toBeNull();
  });

  it('does not even call the server once the local timer ran out', async () => {
    const { store, api, nowRef } = await started();
    nowRef.value = NOW + 301_000;
    const r = await store.getState().submitCode('482913');
    expect(r).toMatchObject({ ok: false, errorKey: 'errors.codeExpired', fatal: true });
    expect(api.verify).not.toHaveBeenCalled();
  });

  it('keeps the session on 409 (bot not confirmed), 429 and network errors', async () => {
    const { store, api } = await started();
    api.verify.mockRejectedValueOnce(httpError(409, 'login_not_confirmed'));
    expect(await store.getState().submitCode('482913')).toMatchObject({
      errorKey: 'errors.notConfirmed',
      fatal: false,
    });
    api.verify.mockRejectedValueOnce(httpError(429));
    expect(await store.getState().submitCode('482913')).toMatchObject({
      errorKey: 'errors.throttled',
      fatal: false,
    });
    api.verify.mockRejectedValueOnce(new AxiosError('Network Error', 'ERR_NETWORK'));
    expect(await store.getState().submitCode('482913')).toMatchObject({
      errorKey: 'errors.network',
      fatal: false,
    });
    expect(store.getState().session).not.toBeNull();
    expect(store.getState().failedAttempts).toBe(0);
  });

  it('fails without a session', async () => {
    const { store, api } = setup();
    expect((await store.getState().submitCode('482913')).ok).toBe(false);
    expect(api.verify).not.toHaveBeenCalled();
  });

  it('does not leak the login token or code into the store snapshot beyond the session', async () => {
    const { store } = await started();
    await store.getState().submitCode('482913');
    expect(JSON.stringify(store.getState())).not.toContain(TOKEN);
    expect(JSON.stringify(store.getState())).not.toContain('482913');
  });
});

describe('login store: in-flight guard', () => {
  it('ignores a second submit while one is running', async () => {
    const { store, api } = await started();
    let release!: (v: AuthResult) => void;
    api.verify.mockReturnValue(new Promise((r) => (release = r)));

    const first = store.getState().submitCode('482913');
    const second = await store.getState().submitCode('482913');
    expect(second).toMatchObject({ ok: false, fatal: false });
    expect(store.getState().isSubmitting).toBe(true);

    release(AUTH);
    expect((await first).ok).toBe(true);
    expect(api.verify).toHaveBeenCalledTimes(1);
    expect(store.getState().isSubmitting).toBe(false);
  });

  it('releases the guard after a failure so the user can retry', async () => {
    const { store, api } = await started();
    api.verify.mockRejectedValueOnce(httpError(400, 'invalid_code'));
    await store.getState().submitCode('000000');
    expect(store.getState().isSubmitting).toBe(false);
    expect((await store.getState().submitCode('482913')).ok).toBe(true);
  });
});

describe('login store: session end reasons', () => {
  it('keeps the session until the auth layer finished (no flash of the login screen)', async () => {
    const { store, onAuthenticated } = await started();
    let sessionDuringAuth: unknown = 'unset';
    onAuthenticated.mockImplementation(async () => {
      sessionDuringAuth = store.getState().session;
    });
    await store.getState().submitCode('482913');
    expect(sessionDuringAuth).not.toBeNull();
    expect(store.getState().session).toBeNull();
    expect(store.getState().endedReason).toBeNull();
  });

  it('reports a generic fatal error when the auth layer fails to persist the session', async () => {
    const { store, onAuthenticated } = await started();
    onAuthenticated.mockRejectedValue(new Error('keystore broken'));
    const r = await store.getState().submitCode('482913');
    expect(r).toMatchObject({ ok: false, errorKey: 'errors.generic', fatal: true });
    expect(store.getState().session).toBeNull();
    expect(store.getState().endedReason).toBe('errors.generic');
  });

  it('records why the session ended (server EXPIRED, 410, exhausted attempts, local timeout)', async () => {
    let ctx = await started();
    ctx.api.status.mockResolvedValue({ status: 'EXPIRED', needs_code: false });
    await ctx.store.getState().checkStatus();
    expect(ctx.store.getState().endedReason).toBe('errors.codeExpired');

    ctx = await started();
    ctx.api.verify.mockRejectedValue(httpError(410, 'login_expired'));
    await ctx.store.getState().submitCode('482913');
    expect(ctx.store.getState().endedReason).toBe('errors.codeExpired');

    ctx = await started();
    ctx.api.verify.mockRejectedValue(httpError(400, 'invalid_code'));
    for (let i = 0; i < 5; i++) await ctx.store.getState().submitCode('000000');
    expect(ctx.store.getState().endedReason).toBe('errors.attemptsExhausted');

    ctx = await started();
    ctx.nowRef.value = NOW + 301_000;
    await ctx.store.getState().submitCode('482913');
    expect(ctx.store.getState().endedReason).toBe('errors.codeExpired');
  });

  it('clears the reason on a new start and on reset', async () => {
    const { store, api } = await started();
    api.status.mockResolvedValue({ status: 'EXPIRED', needs_code: false });
    await store.getState().checkStatus();
    await store.getState().start();
    expect(store.getState().endedReason).toBeNull();

    api.status.mockResolvedValue({ status: 'EXPIRED', needs_code: false });
    await store.getState().checkStatus();
    store.getState().reset();
    expect(store.getState().endedReason).toBeNull();
  });
});

describe('login store: reset', () => {
  it('clears session, attempts and confirmation', async () => {
    const { store, api } = await started();
    api.status.mockResolvedValue({ status: 'CONFIRMED', needs_code: true });
    await store.getState().checkStatus();
    store.getState().reset();
    expect(store.getState()).toMatchObject({ session: null, failedAttempts: 0, isConfirmed: false });
  });
});
