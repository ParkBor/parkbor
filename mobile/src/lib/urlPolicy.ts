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

/** WebSocket URL: wss only in release builds; ws(s) in dev. */
export function validateWsUrl(url: string, isDev: boolean): string {
  const allowed = isDev ? /^wss?:\/\//i : /^wss:\/\//i;
  if (!allowed.test(url)) {
    throw new Error(isDev ? 'wsUrl must be a ws(s) URL' : 'wsUrl must use wss in release builds');
  }
  return trimSlashes(url);
}

/** Telegram bot username (leading @ tolerated). */
export function validateBotName(name: string): string {
  const bot = name.replace(/^@/, '');
  if (!BOT_NAME_PATTERN.test(bot)) throw new Error('telegramBot must be a Telegram bot username');
  return bot;
}
