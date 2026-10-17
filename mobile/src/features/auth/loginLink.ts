const LOGIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const BOT_NAME_PATTERN = /^[A-Za-z0-9_]{3,64}$/;
const BOT_URL_PATTERN =
  /^https:\/\/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,64})\?start=([A-Za-z0-9_-]{16,64})$/;

/** Mirrors the backend LOGIN_TOKEN_VALIDATOR. */
export function isValidLoginToken(value: unknown): value is string {
  return typeof value === 'string' && LOGIN_TOKEN_PATTERN.test(value);
}

/**
 * The only URL the login flow may hand to Linking.openURL: an https t.me deep link to OUR
 * bot (`expectedBot`, case-insensitive, optional leading @) whose `start` parameter is
 * exactly our login token (no extra params/paths/userinfo).
 */
export function isTrustedBotUrl(url: unknown, loginToken: string, expectedBot: string): boolean {
  const bot = expectedBot.replace(/^@/, '');
  if (typeof url !== 'string' || !BOT_NAME_PATTERN.test(bot)) return false;
  const match = BOT_URL_PATTERN.exec(url);
  return (
    match !== null &&
    match[1]?.toLowerCase() === bot.toLowerCase() &&
    match[2] === loginToken
  );
}
