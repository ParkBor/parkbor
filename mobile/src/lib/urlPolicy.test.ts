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
