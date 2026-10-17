import { describe, expect, it } from 'vitest';

import { isValidLoginToken, isTrustedBotUrl } from '@/features/auth/loginLink';

const BOT = 'HabiParkingBot';
const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF123_-abc';

describe('isValidLoginToken', () => {
  it('accepts url-safe tokens of 16..64 chars', () => {
    expect(isValidLoginToken(TOKEN)).toBe(true);
    expect(isValidLoginToken('a'.repeat(16))).toBe(true);
    expect(isValidLoginToken('a'.repeat(64))).toBe(true);
  });

  it.each(['', 'short', 'a'.repeat(15), 'a'.repeat(65), `${TOKEN}!`, 'a b'.repeat(8), '../etc/passwd'])(
    'rejects %j',
    (value) => {
      expect(isValidLoginToken(value)).toBe(false);
    },
  );

  it('rejects non-strings', () => {
    expect(isValidLoginToken(undefined)).toBe(false);
    expect(isValidLoginToken(null)).toBe(false);
    expect(isValidLoginToken(123)).toBe(false);
  });
});

describe('isTrustedBotUrl', () => {
  it('rejects every URL when the expected bot name is unusable', () => {
    expect(isTrustedBotUrl(`https://t.me/HabiParkingBot?start=${TOKEN}`, TOKEN, '')).toBe(false);
    expect(isTrustedBotUrl(`https://t.me/HabiParkingBot?start=${TOKEN}`, TOKEN, 'bad name!')).toBe(false);
  });

  it('tolerates a leading @ in the configured bot name', () => {
    expect(isTrustedBotUrl(`https://t.me/HabiParkingBot?start=${TOKEN}`, TOKEN, '@HabiParkingBot')).toBe(true);
  });

  it('accepts the t.me deep link carrying the same token', () => {
    expect(isTrustedBotUrl(`https://t.me/HabiParkingBot?start=${TOKEN}`, TOKEN, BOT)).toBe(true);
    expect(isTrustedBotUrl(`https://telegram.me/habiparkingbot?start=${TOKEN}`, TOKEN, BOT)).toBe(true);
  });

  it.each([
    ['other host', `https://evil.com/HabiParkingBot?start=${TOKEN}`],
    ['lookalike host', `https://t.me.evil.com/HabiParkingBot?start=${TOKEN}`],
    ['userinfo trick', `https://t.me@evil.com/HabiParkingBot?start=${TOKEN}`],
    ['http', `http://t.me/HabiParkingBot?start=${TOKEN}`],
    ['javascript scheme', 'javascript:alert(1)'],
    ['file scheme', 'file:///etc/passwd'],
    ['intent scheme', 'intent://t.me/x#Intent;scheme=https;end'],
    ['different token', `https://t.me/HabiParkingBot?start=${'z'.repeat(40)}`],
    ['extra params', `https://t.me/HabiParkingBot?start=${TOKEN}&x=1`],
    ['extra path', `https://t.me/a/b?start=${TOKEN}`],
    ['another bot', `https://t.me/OtherBot?start=${TOKEN}`],
    ['bot name prefix', `https://t.me/HabiParkingBot2?start=${TOKEN}`],
    ['no start', 'https://t.me/HabiParkingBot'],
    ['empty', ''],
  ])('rejects %s', (_name, url) => {
    expect(isTrustedBotUrl(url, TOKEN, BOT)).toBe(false);
  });
});
