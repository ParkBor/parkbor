import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RETRY_DELAYS_MS,
  SYNC_THROTTLE_MS,
  createDeviceRegistrar,
  isExpoPushToken,
} from '@/features/push/deviceRegistrar';

const TOKEN = 'ExponentPushToken[abcDEF123_-xyz]';
const TOKEN2 = 'ExpoPushToken[zzzzzzzzzzzzzzzzzzzzzz]';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(overrides: { permission?: 'granted' | 'denied' | 'undetermined'; token?: string | null | Error } = {}) {
  const state = { permission: overrides.permission ?? 'granted', token: overrides.token === undefined ? TOKEN : overrides.token };
  const register = vi.fn<(platform: 'ios' | 'android', token: string) => Promise<void>>().mockResolvedValue(undefined);
  const seen: (string | null)[] = [];
  const registrar = createDeviceRegistrar({
    platform: 'android',
    getPermission: async () => state.permission,
    getToken: async () => {
      if (state.token instanceof Error) throw state.token;
      return state.token;
    },
    register,
    onCurrentToken: (token) => seen.push(token),
  });
  return { state, register, registrar, seen };
}

describe('isExpoPushToken (mirrors the backend validator)', () => {
  it('accepts Expo and Exponent tokens', () => {
    expect(isExpoPushToken(TOKEN)).toBe(true);
    expect(isExpoPushToken(TOKEN2)).toBe(true);
  });

  it.each(['', 'abc', 'ExponentPushToken[]', 'ExponentPushToken[a b]', `ExponentPushToken[${'a'.repeat(200)}]`, 'FCM:xyz', 5, null])(
    'rejects %s',
    (value) => {
      expect(isExpoPushToken(value)).toBe(false);
    },
  );
});

describe('sync', () => {
  it('registers the token with the platform once permission is granted', async () => {
    const { registrar, register } = setup();
    await expect(registrar.sync('u1')).resolves.toBe('registered');
    expect(register).toHaveBeenCalledExactlyOnceWith('android', TOKEN);
  });

  it('does not register again for the same user and token', async () => {
    const { registrar, register } = setup();
    await registrar.sync('u1');
    await expect(registrar.sync('u1')).resolves.toBe('unchanged');
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('re-registers when the token changed, and for another user on the same phone', async () => {
    const { registrar, register, state } = setup();
    await registrar.sync('u1');
    state.token = TOKEN2;
    await expect(registrar.sync('u1')).resolves.toBe('registered');
    expect(register).toHaveBeenLastCalledWith('android', TOKEN2);
    await registrar.sync('u2');
    expect(register).toHaveBeenCalledTimes(3);
  });

  it('never asks for permission itself and registers nothing without it', async () => {
    for (const permission of ['denied', 'undetermined'] as const) {
      const { registrar, register } = setup({ permission });
      await expect(registrar.sync('u1')).resolves.toBe('no_permission');
      expect(register).not.toHaveBeenCalled();
    }
  });

  it('does nothing without a session', async () => {
    const { registrar, register } = setup();
    await expect(registrar.sync(null)).resolves.toBe('no_session');
    expect(register).not.toHaveBeenCalled();
  });

  it.each([[null], [new Error('no projectId')], ['garbage']])('no usable token (%s) -> no request', async (token) => {
    const { registrar, register } = setup({ token });
    await expect(registrar.sync('u1')).resolves.toBe('no_token');
    expect(register).not.toHaveBeenCalled();
  });

  it('parallel syncs make one request', async () => {
    const { registrar, register } = setup();
    const results = await Promise.all([registrar.sync('u1'), registrar.sync('u1'), registrar.sync('u1')]);
    expect(register).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r === 'registered')).toHaveLength(1);
  });
});

describe('current token (what a logout must carry)', () => {
  it('is known once registered, and cleared at the end of the session', async () => {
    const { registrar, seen } = setup();
    expect(registrar.currentToken()).toBeNull();
    await registrar.sync('u1');
    expect(registrar.currentToken()).toBe(TOKEN);
    registrar.endSession();
    expect(registrar.currentToken()).toBeNull();
    expect(seen.at(-1)).toBeNull();
    expect(seen).toContain(TOKEN);
  });

  it('includes a registration that is still in flight (the server may already know it)', async () => {
    const { registrar, register } = setup();
    let finish: () => void = () => undefined;
    register.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const pending = registrar.sync('u1');
    await vi.advanceTimersByTimeAsync(0);
    expect(registrar.currentToken()).toBe(TOKEN);
    finish();
    await pending;
    expect(registrar.currentToken()).toBe(TOKEN);
  });

  it('a registration finishing after the session ended leaves no registered state', async () => {
    const { registrar, register } = setup();
    let finish: () => void = () => undefined;
    register.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const pending = registrar.sync('u1');
    await vi.advanceTimersByTimeAsync(0);
    registrar.endSession();
    finish();
    await expect(pending).resolves.toBe('no_session');
    expect(registrar.currentToken()).toBeNull();
    await expect(registrar.sync('u1')).resolves.toBe('registered'); // not mistaken for "already registered"
  });

  it('a failed request does not leave the token behind', async () => {
    const { registrar, register } = setup();
    register.mockRejectedValueOnce(new Error('503'));
    await registrar.sync('u1');
    expect(registrar.currentToken()).toBeNull();
  });

  it('forgets the registration, so the next login registers again', async () => {
    const { registrar, register } = setup();
    await registrar.sync('u1');
    registrar.endSession();
    await registrar.sync('u1');
    expect(register).toHaveBeenCalledTimes(2);
  });
});

describe('retry after a failed registration', () => {
  it('retries with backoff while the session lives, then stops', async () => {
    const { registrar, register } = setup();
    register.mockRejectedValue(new Error('503'));
    await expect(registrar.sync('u1')).resolves.toBe('failed');
    for (const delay of RETRY_DELAYS_MS) {
      expect(register.mock.calls.length).toBeLessThanOrEqual(RETRY_DELAYS_MS.length);
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(register).toHaveBeenCalledTimes(1 + RETRY_DELAYS_MS.length);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(register).toHaveBeenCalledTimes(1 + RETRY_DELAYS_MS.length);
  });

  it('stops retrying as soon as one succeeds', async () => {
    const { registrar, register } = setup();
    register.mockRejectedValueOnce(new Error('503'));
    await registrar.sync('u1');
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] ?? 0);
    expect(register).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('does not retry after the session ended', async () => {
    const { registrar, register } = setup();
    register.mockRejectedValue(new Error('503'));
    await registrar.sync('u1');
    registrar.endSession();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(register).toHaveBeenCalledTimes(1);
  });
});

describe('syncThrottled (foreground returns)', () => {
  it('skips a check made within the last minute and allows one after it', async () => {
    const { registrar, register } = setup({ permission: 'denied' });
    await expect(registrar.syncThrottled('u1')).resolves.toBe('no_permission');
    await expect(registrar.syncThrottled('u1')).resolves.toBe('throttled');
    vi.advanceTimersByTime(SYNC_THROTTLE_MS);
    await expect(registrar.syncThrottled('u1')).resolves.toBe('no_permission');
    expect(register).not.toHaveBeenCalled();
  });

  it('a plain sync (login, token change, permission just granted) is never throttled', async () => {
    const { registrar, state } = setup({ permission: 'denied' });
    await registrar.syncThrottled('u1');
    state.permission = 'granted';
    await expect(registrar.sync('u1')).resolves.toBe('registered');
  });

  it('a new session starts unthrottled', async () => {
    const { registrar } = setup({ permission: 'denied' });
    await registrar.syncThrottled('u1');
    registrar.endSession();
    await expect(registrar.syncThrottled('u1')).resolves.toBe('no_permission');
  });
});
