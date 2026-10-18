const BOT_NAME_PATTERN = /^[A-Za-z0-9_]{3,64}$/;

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** API base URL: https only in release builds; http(s) in dev. */
export function validateApiUrl(url: string, isDev: boolean): string {
  const allowed = isDev ? /^https?:\/\//i : /^https:\/\//i;
  if (!allowed.test(url)) {
    throw new Error(isDev ? 'apiUrl must be an http(s) URL' : 'apiUrl must use https in release builds');
  }
  return trimSlashes(url);
}

const WS_URL_PATTERN = /^(wss?):\/\/((?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?((?:\/[A-Za-z0-9._~-]*)*)$/i;

/**
 * WebSocket base URL: wss only in release builds; ws(s) in dev. Strictly `scheme://host[:port][/path]`:
 * no userinfo, query, fragment, whitespace or dot segments (the ticket is appended as the only
 * query parameter, and a credential in the base URL would end up in every connection log).
 * Parsed by hand: React Native's URL polyfill does not implement every accessor.
 */
export function validateWsUrl(url: string, isDev: boolean): string {
  const match = WS_URL_PATTERN.exec(url);
  const scheme = match?.[1]?.toLowerCase();
  if (!match || (scheme !== 'wss' && scheme !== 'ws')) {
    throw new Error(isDev ? 'wsUrl must be a ws(s) URL' : 'wsUrl must use wss in release builds');
  }
  if (!isDev && scheme !== 'wss') throw new Error('wsUrl must use wss in release builds');
  const port = match[3];
  if (port !== undefined && Number(port) > 65_535) throw new Error('wsUrl has an invalid port');
  if (/(^|\/)\.\.?(\/|$)/.test(match[4] ?? '')) throw new Error('wsUrl must not contain dot segments');
  return trimSlashes(url);
}

/** Telegram bot username (leading @ tolerated). */
export function validateBotName(name: string): string {
  const bot = name.replace(/^@/, '');
  if (!BOT_NAME_PATTERN.test(bot)) throw new Error('telegramBot must be a Telegram bot username');
  return bot;
}
