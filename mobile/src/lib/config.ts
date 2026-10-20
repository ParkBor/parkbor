import Constants from 'expo-constants';

import { resolveMapConfig, type MapConfigResult } from '@/features/map/mapStyle';
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

/** Like getTelegramBot, but a missing / malformed setting yields '' (no bot URL is then trusted) instead of crashing at import. */
export function getTelegramBotOrEmpty(): string {
  try {
    return getTelegramBot();
  } catch {
    return '';
  }
}

function optionalExtraString(name: 'mapStyleUrl' | 'mapStyleUrlDark' | 'mapAttribution'): string | undefined {
  const value: unknown = Constants.expoConfig?.extra?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Map style URLs from `extra.mapStyleUrl` / `extra.mapStyleUrlDark` (EXPO_PUBLIC_MAP_STYLE_URL[_DARK]); the default
 * is OpenFreeMap (no key). A malformed URL does not crash the app: the result says so and the map shows its failure panel.
 */
export function getMapConfig(): MapConfigResult {
  return resolveMapConfig({
    light: optionalExtraString('mapStyleUrl'),
    dark: optionalExtraString('mapStyleUrlDark'),
    extra: optionalExtraString('mapAttribution'),
    isDev: __DEV__,
  });
}
