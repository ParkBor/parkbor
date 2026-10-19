import Constants from 'expo-constants';

import { attributionFor, resolveMapStyles, type MapStyles } from '@/features/map/mapStyle';
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

function optionalExtraString(name: 'mapStyleUrl' | 'mapStyleUrlDark' | 'mapAttribution'): string | undefined {
  const value: unknown = Constants.expoConfig?.extra?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface MapConfig {
  styles: MapStyles;
  /** Credit line per style (OpenStreetMap + whatever the tile provider requires). */
  attribution: { light: string; dark: string };
}

/**
 * Map style URLs from `extra.mapStyleUrl` / `extra.mapStyleUrlDark` (EXPO_PUBLIC_MAP_STYLE_URL[_DARK]); the default
 * is OpenFreeMap (no key). A malformed URL throws at startup rather than loading something unexpected.
 */
export function getMapConfig(): MapConfig {
  const styles = resolveMapStyles({
    light: optionalExtraString('mapStyleUrl'),
    dark: optionalExtraString('mapStyleUrlDark'),
    isDev: __DEV__,
  });
  const extra = optionalExtraString('mapAttribution');
  return { styles, attribution: { light: attributionFor(styles.light, extra), dark: attributionFor(styles.dark, extra) } };
}
