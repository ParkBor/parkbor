import Constants from 'expo-constants';

import { validateApiUrl, validateBotName, validateWsUrl } from '@/lib/urlPolicy';

function extraString(name: 'apiUrl' | 'wsUrl' | 'telegramBot'): string {
  const value: unknown = Constants.expoConfig?.extra?.[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`app.config.ts extra.${name} is missing (set EXPO_PUBLIC_* env)`);
  }
  return value;
}

/** API base URL from app.config.ts `extra.apiUrl` (EXPO_PUBLIC_API_URL). Release builds require https. */
export function getApiUrl(): string {
  return validateApiUrl(extraString('apiUrl'), __DEV__);
}

/** WebSocket URL from `extra.wsUrl`. Release builds require wss. */
export function getWsUrl(): string {
  return validateWsUrl(extraString('wsUrl'), __DEV__);
}

/** Expected bot username from `extra.telegramBot`; deep links to any other bot are refused. */
export function getTelegramBot(): string {
  return validateBotName(extraString('telegramBot'));
}
