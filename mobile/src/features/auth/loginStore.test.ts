import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loginStore } from '@/features/auth/loginStore';

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_-abc';
const calls: string[] = [];

const mocks = vi.hoisted(() => ({
  openURL: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
  verify: vi.fn(),
  setSession: vi.fn(),
  setStep: vi.fn(),
}));

vi.mock('react-native', () => ({ Linking: { openURL: mocks.openURL } }));
vi.mock('@/lib/authApi', () => ({
  authApi: { start: mocks.start, status: mocks.status, verify: mocks.verify },
}));
vi.mock('@/lib/deviceId', () => ({ getDeviceId: async () => 'device-1' }));
vi.mock('@/lib/config', () => ({ getTelegramBot: () => 'ParkBorBot' }));
vi.mock('@/store/auth', () => ({
  authStore: { getState: () => ({ setSession: mocks.setSession }) },
}));
vi.mock('@/store/onboarding', () => ({
  useOnboardingStore: { getState: () => ({ setStep: mocks.setStep }) },
}));


const USER = { id: 1 };

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  loginStore.getState().reset();
  mocks.start.mockResolvedValue({
    login_token: TOKEN,
    bot_url: `https://t.me/ParkBorBot?start=${TOKEN}`,
    expires_in: 300,
  });
  mocks.openURL.mockResolvedValue(undefined);
  mocks.setStep.mockImplementation((s: unknown) => calls.push(`step:${String(s)}`));
  mocks.setSession.mockImplementation(async () => {
    calls.push('setSession');
  });
});

describe('loginStore wiring', () => {
  it('opens the bot link through Linking', async () => {
    await loginStore.getState().start();
    expect(mocks.openURL).toHaveBeenCalledWith(`https://t.me/ParkBorBot?start=${TOKEN}`);
  });

  it('refuses a link to another bot (extra.telegramBot is enforced)', async () => {
    mocks.start.mockResolvedValue({
      login_token: TOKEN,
      bot_url: `https://t.me/OtherBot?start=${TOKEN}`,
      expires_in: 300,
    });
    expect((await loginStore.getState().start()).ok).toBe(false);
    expect(mocks.openURL).not.toHaveBeenCalled();
  });

  it('for a new user sets the onboarding step BEFORE the session so the guard routes correctly', async () => {
    mocks.verify.mockResolvedValue({ access: 'a', refresh: 'r', user: USER, is_new: true });
    await loginStore.getState().start();
    const result = await loginStore.getState().submitCode('482913');

    expect(result).toEqual({ ok: true, value: { isNew: true } });
    expect(calls).toEqual(['step:profile', 'setSession']);
    expect(mocks.setSession).toHaveBeenCalledWith({ access: 'a', refresh: 'r', user: USER });
  });

  it('for an existing user skips onboarding', async () => {
    mocks.verify.mockResolvedValue({ access: 'a', refresh: 'r', user: USER, is_new: false });
    await loginStore.getState().start();
    await loginStore.getState().submitCode('482913');
    expect(calls).toEqual(['setSession']);
  });
});
