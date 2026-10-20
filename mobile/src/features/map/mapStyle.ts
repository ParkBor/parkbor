// Map style configuration. The map is MapLibre (vector tiles, OpenStreetMap data). The tile
// provider is a style URL chosen by configuration, never hardcoded into a screen:
//   EXPO_PUBLIC_MAP_STYLE_URL        light style (default: OpenFreeMap "liberty", no key)
//   EXPO_PUBLIC_MAP_STYLE_URL_DARK   dark style  (default: OpenFreeMap "dark"; with a custom light style: the same one)
//   EXPO_PUBLIC_MAP_ATTRIBUTION      extra credit for a self-hosted / unknown provider
// The volunteer-run tile.openstreetmap.org servers are refused: their usage policy forbids app traffic.

export const DEFAULT_LIGHT_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const DEFAULT_DARK_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

const MAX_URL_LENGTH = 2048;
const MAX_EXTRA_ATTRIBUTION = 120;
const URL_PATTERN = /^(https?):\/\/([^/?#@\s\\]+)(\/[^?#\s\\]*)?(\?[^#\s\\]*)?$/i;
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2']);

function hostOf(authority: string): string {
  return (authority.replace(/:\d{1,5}$/, '') || authority).toLowerCase();
}

/**
 * A style URL: https only (http to a local server in dev builds), no userinfo, no fragment, no
 * whitespace. A query string is allowed (providers put a key there). Errors never repeat the URL.
 */
export function validateMapStyleUrl(url: string, isDev: boolean): string {
  const value = url.trim();
  const match = value.length <= MAX_URL_LENGTH ? URL_PATTERN.exec(value) : null;
  if (!match) throw new Error('Map style URL must be a plain https URL');
  const scheme = match[1]?.toLowerCase();
  const host = hostOf(match[2] ?? '');
  if (host === '') throw new Error('Map style URL must be a plain https URL');
  if (host === 'tile.openstreetmap.org' || host.endsWith('.tile.openstreetmap.org')) {
    throw new Error('The OpenStreetMap volunteer tile servers must not be used by the app');
  }
  if (scheme !== 'https' && !(isDev && LOCAL_DEV_HOSTS.has(host))) {
    throw new Error('Map style URL must use https');
  }
  return value;
}

export interface MapStyles {
  light: string;
  dark: string;
}

/** Light and dark style for the current configuration. Invalid configuration throws (no silent fallback). */
export function resolveMapStyles(input: { light?: string; dark?: string; isDev: boolean }): MapStyles {
  const light = input.light?.trim() ? validateMapStyleUrl(input.light, input.isDev) : null;
  const dark = input.dark?.trim() ? validateMapStyleUrl(input.dark, input.isDev) : null;
  if (light && dark) return { light, dark };
  if (light) return { light, dark: light }; // never mix a custom provider with the default one
  return { light: DEFAULT_LIGHT_STYLE_URL, dark: dark ?? DEFAULT_DARK_STYLE_URL };
}

function providerCredit(styleUrl: string): string | null {
  const match = URL_PATTERN.exec(styleUrl.trim());
  const host = match ? hostOf(match[2] ?? '') : '';
  if (host === 'tiles.openfreemap.org') return 'OpenFreeMap © OpenMapTiles';
  if (host === 'api.maptiler.com') return '© MapTiler © OpenMapTiles';
  if (host === 'tiles.stadiamaps.com') return '© Stadia Maps © OpenMapTiles';
  return null;
}

function cleanExtra(text: string | undefined): string | null {
  if (!text) return null;
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_EXTRA_ATTRIBUTION);
  return cleaned === '' ? null : cleaned;
}

/** The credit line shown on the map: always OpenStreetMap, plus what the tile provider requires. */
export function attributionFor(styleUrl: string, extra?: string): string {
  const credit = providerCredit(styleUrl) ?? cleanExtra(extra);
  return credit ? `${OSM_ATTRIBUTION} · ${credit}` : OSM_ATTRIBUTION;
}

export type MapConfigResult =
  | { ok: true; styles: MapStyles; attribution: { light: string; dark: string } }
  /** Misconfigured style: the map shows its failure panel; the credit line stays correct for whatever is shown. */
  | { ok: false; attribution: { light: string; dark: string } };

/** Style + credit for the configuration; an invalid URL becomes a result, never an exception. */
export function resolveMapConfig(input: { light?: string; dark?: string; extra?: string; isDev: boolean }): MapConfigResult {
  try {
    const styles = resolveMapStyles(input);
    return {
      ok: true,
      styles,
      attribution: { light: attributionFor(styles.light, input.extra), dark: attributionFor(styles.dark, input.extra) },
    };
  } catch {
    return { ok: false, attribution: { light: OSM_ATTRIBUTION, dark: OSM_ATTRIBUTION } };
  }
}
