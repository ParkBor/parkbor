import { describe, expect, it } from 'vitest';

import { parseLoginSession, serializeLoginSession } from '@/features/auth/loginSessionStorage';

const TOKEN = 'a'.repeat(32);
const BOT = 'ParkBorBot';
const URL = `https://t.me/${BOT}?start=${TOKEN}`;
const NOW = 1_000_000;
const session = { loginToken: TOKEN, botUrl: URL, expiresAt: NOW + 60_000 };

describe('parseLoginSession', () => {
  it('round-trips a live session', () => {
    expect(parseLoginSession(serializeLoginSession(session), NOW, BOT)).toEqual(session);
  });

  it('drops an expired session (also exactly at the expiry)', () => {
    expect(parseLoginSession(serializeLoginSession({ ...session, expiresAt: NOW }), NOW, BOT)).toBeNull();
    expect(parseLoginSession(serializeLoginSession({ ...session, expiresAt: NOW - 1 }), NOW, BOT)).toBeNull();
  });

  it('refuses a stored bot URL that is not exactly our bot with our token (storage is not trusted)', () => {
    for (const botUrl of [`https://t.me/EvilBot?start=${TOKEN}`, `https://evil.com/${BOT}?start=${TOKEN}`, `https://t.me/${BOT}?start=${'b'.repeat(32)}`, 'javascript:alert(1)']) {
      expect(parseLoginSession(serializeLoginSession({ ...session, botUrl }), NOW, BOT)).toBeNull();
    }
  });

  it('refuses a malformed token', () => {
    expect(parseLoginSession(serializeLoginSession({ ...session, loginToken: 'short' }), NOW, BOT)).toBeNull();
  });

  it('refuses everything when the bot is not configured', () => {
    expect(parseLoginSession(serializeLoginSession(session), NOW, '')).toBeNull();
  });

  it.each([null, '', 'not json', '[]', '"x"', '{"loginToken":1}', JSON.stringify({ ...session, expiresAt: 'soon' })])('returns null for %s', (raw) => {
    expect(parseLoginSession(raw, NOW, BOT)).toBeNull();
  });

  it('does not store or return anything beyond the three fields (no code)', () => {
    const raw = serializeLoginSession({ ...session, code: '123456' } as typeof session);
    expect(raw).not.toContain('123456');
    expect(Object.keys(parseLoginSession(raw, NOW, BOT) ?? {}).sort()).toEqual(['botUrl', 'expiresAt', 'loginToken']);
  });
});
