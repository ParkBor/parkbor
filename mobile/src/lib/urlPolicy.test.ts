import { describe, expect, it } from 'vitest';

import { validateApiUrl, validateBotName, validateWsUrl } from '@/lib/urlPolicy';

describe('validateApiUrl', () => {
  it('requires https in release builds', () => {
    expect(validateApiUrl('https://api.parkbor.uz/api/v1', false)).toBe('https://api.parkbor.uz/api/v1');
    expect(() => validateApiUrl('http://api.parkbor.uz/api/v1', false)).toThrow(/https/);
  });

  it('allows http(s) in dev and trims trailing slashes', () => {
    expect(validateApiUrl('http://localhost:8000/api/v1///', true)).toBe('http://localhost:8000/api/v1');
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'ws://x', '', 'api.parkbor.uz'])(
    'rejects %j even in dev',
    (url) => {
      expect(() => validateApiUrl(url, true)).toThrow();
    },
  );
});

describe('validateWsUrl', () => {
  it('requires wss in release builds', () => {
    expect(validateWsUrl('wss://api.parkbor.uz/ws', false)).toBe('wss://api.parkbor.uz/ws');
    expect(() => validateWsUrl('ws://api.parkbor.uz/ws', false)).toThrow(/wss/);
    expect(() => validateWsUrl('https://api.parkbor.uz/ws', false)).toThrow();
  });

  it('allows ws(s) in dev', () => {
    expect(validateWsUrl('ws://localhost:8000/ws', true)).toBe('ws://localhost:8000/ws');
  });

  it('rejects other schemes in dev', () => {
    expect(() => validateWsUrl('http://localhost:8000/ws', true)).toThrow();
  });

  it('trims trailing slashes and accepts host:port, IPv6 and nested paths', () => {
    expect(validateWsUrl('wss://api.parkbor.uz/ws///', false)).toBe('wss://api.parkbor.uz/ws');
    expect(validateWsUrl('wss://api.parkbor.uz:8443/v1/ws', false)).toBe('wss://api.parkbor.uz:8443/v1/ws');
    expect(validateWsUrl('ws://[::1]:8000/ws', true)).toBe('ws://[::1]:8000/ws');
    expect(validateWsUrl('wss://api.parkbor.uz', false)).toBe('wss://api.parkbor.uz');
  });

  it.each([
    ['userinfo', 'wss://user:pass@api.parkbor.uz/ws'],
    ['userinfo without password', 'wss://user@api.parkbor.uz/ws'],
    ['query', 'wss://api.parkbor.uz/ws?ticket=x'],
    ['fragment', 'wss://api.parkbor.uz/ws#x'],
    ['whitespace', 'wss://api.parkbor.uz/ws '],
    ['newline', 'wss://api.parkbor.uz/ws\n'],
    ['space in host', 'wss://api parkbor.uz/ws'],
    ['backslash', 'wss://api.parkbor.uz\\evil.com/ws'],
    ['dot segments', 'wss://api.parkbor.uz/ws/../admin'],
    ['port out of range', 'wss://api.parkbor.uz:99999/ws'],
    ['empty host', 'wss:///ws'],
    ['empty', ''],
    ['scheme only', 'wss://'],
  ])('rejects %s', (_name, url) => {
    expect(() => validateWsUrl(url, true)).toThrow();
    expect(() => validateWsUrl(url, false)).toThrow();
  });

  it('release builds reject plain ws even when it is otherwise valid', () => {
    expect(() => validateWsUrl('ws://api.parkbor.uz/ws', false)).toThrow(/wss/);
    expect(() => validateWsUrl('WS://api.parkbor.uz/ws', false)).toThrow(/wss/);
  });
});

describe('validateBotName', () => {
  it('accepts telegram usernames, with or without @', () => {
    expect(validateBotName('ParkBorBot')).toBe('ParkBorBot');
    expect(validateBotName('@parkbor_dev_bot')).toBe('parkbor_dev_bot');
  });

  it.each(['', 'ab', 'has space', 'bad!name', 'a'.repeat(65)])('rejects %j', (name) => {
    expect(() => validateBotName(name)).toThrow();
  });
});
