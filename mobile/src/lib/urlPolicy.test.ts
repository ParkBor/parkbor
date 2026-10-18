import { describe, expect, it } from 'vitest';

import { validateApiUrl, validateBotName, validateWsUrl } from '@/lib/urlPolicy';

describe('validateApiUrl', () => {
  it('requires https in release builds', () => {
    expect(validateApiUrl('https://api.habi.uz/api/v1', false)).toBe('https://api.habi.uz/api/v1');
    expect(() => validateApiUrl('http://api.habi.uz/api/v1', false)).toThrow(/https/);
  });

  it('allows http(s) in dev and trims trailing slashes', () => {
    expect(validateApiUrl('http://localhost:8000/api/v1///', true)).toBe('http://localhost:8000/api/v1');
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'ws://x', '', 'api.habi.uz'])(
    'rejects %j even in dev',
    (url) => {
      expect(() => validateApiUrl(url, true)).toThrow();
    },
  );
});

describe('validateWsUrl', () => {
  it('requires wss in release builds', () => {
    expect(validateWsUrl('wss://api.habi.uz/ws', false)).toBe('wss://api.habi.uz/ws');
    expect(() => validateWsUrl('ws://api.habi.uz/ws', false)).toThrow(/wss/);
    expect(() => validateWsUrl('https://api.habi.uz/ws', false)).toThrow();
  });

  it('allows ws(s) in dev', () => {
    expect(validateWsUrl('ws://localhost:8000/ws', true)).toBe('ws://localhost:8000/ws');
  });

  it('rejects other schemes in dev', () => {
    expect(() => validateWsUrl('http://localhost:8000/ws', true)).toThrow();
  });

  it('trims trailing slashes and accepts host:port, IPv6 and nested paths', () => {
    expect(validateWsUrl('wss://api.habi.uz/ws///', false)).toBe('wss://api.habi.uz/ws');
    expect(validateWsUrl('wss://api.habi.uz:8443/v1/ws', false)).toBe('wss://api.habi.uz:8443/v1/ws');
    expect(validateWsUrl('ws://[::1]:8000/ws', true)).toBe('ws://[::1]:8000/ws');
    expect(validateWsUrl('wss://api.habi.uz', false)).toBe('wss://api.habi.uz');
  });

  it.each([
    ['userinfo', 'wss://user:pass@api.habi.uz/ws'],
    ['userinfo without password', 'wss://user@api.habi.uz/ws'],
    ['query', 'wss://api.habi.uz/ws?ticket=x'],
    ['fragment', 'wss://api.habi.uz/ws#x'],
    ['whitespace', 'wss://api.habi.uz/ws '],
    ['newline', 'wss://api.habi.uz/ws\n'],
    ['space in host', 'wss://api habi.uz/ws'],
    ['backslash', 'wss://api.habi.uz\\evil.com/ws'],
    ['dot segments', 'wss://api.habi.uz/ws/../admin'],
    ['port out of range', 'wss://api.habi.uz:99999/ws'],
    ['empty host', 'wss:///ws'],
    ['empty', ''],
    ['scheme only', 'wss://'],
  ])('rejects %s', (_name, url) => {
    expect(() => validateWsUrl(url, true)).toThrow();
    expect(() => validateWsUrl(url, false)).toThrow();
  });

  it('release builds reject plain ws even when it is otherwise valid', () => {
    expect(() => validateWsUrl('ws://api.habi.uz/ws', false)).toThrow(/wss/);
    expect(() => validateWsUrl('WS://api.habi.uz/ws', false)).toThrow(/wss/);
  });
});

describe('validateBotName', () => {
  it('accepts telegram usernames, with or without @', () => {
    expect(validateBotName('HabiParkingBot')).toBe('HabiParkingBot');
    expect(validateBotName('@habi_dev_bot')).toBe('habi_dev_bot');
  });

  it.each(['', 'ab', 'has space', 'bad!name', 'a'.repeat(65)])('rejects %j', (name) => {
    expect(() => validateBotName(name)).toThrow();
  });
});
