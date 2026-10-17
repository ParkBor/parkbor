import { isValidLatLng, type LatLng } from '@/features/map/geo';

/** 'geo' (Android geo: URI) is only the last resort when no navigator app is installed. */
export type NavApp = 'yandex' | 'google' | 'apple' | 'geo';
export type NavPlatform = 'ios' | 'android';

const COORD_DIGITS = 6;

/** Priority order: Yandex Navigator is the most used navigator in Uzbekistan. */
const PRIORITY: readonly NavApp[] = ['yandex', 'google', 'apple'];

/** Probe-able apps only (geo: is never probed, it is the fallback). */

/**
 * Probe schemes for Linking.canOpenURL. They must be declared: iOS LSApplicationQueriesSchemes
 * and Android <queries> (both in app.config.ts), otherwise the OS answers "false" for everything.
 */
const PROBE: Readonly<Record<NavPlatform, Partial<Record<NavApp, string>>>> = {
  ios: { yandex: 'yandexnavi://', google: 'comgooglemaps://' },
  android: { yandex: 'yandexnavi://', google: 'google.navigation:' },
};

/** Fixed-point text of a validated finite number (never exponent notation). */
function fixed(value: number): string {
  return value.toFixed(COORD_DIGITS);
}

function isSafeCoordinate(point: LatLng): boolean {
  return typeof point.lat === 'number' && typeof point.lng === 'number' && isValidLatLng(point);
}

/**
 * Deep link that drives to `destination`. The URL is assembled only from validated floats, so
 * nothing but the destination coordinates reaches the other app (no origin, no names, no ids).
 * Returns null for invalid coordinates or an app that does not exist on the platform.
 */
export function buildNavUrl(app: NavApp, destination: LatLng, platform: NavPlatform): string | null {
  if (!isSafeCoordinate(destination)) return null;
  const lat = fixed(destination.lat);
  const lng = fixed(destination.lng);
  switch (app) {
    case 'yandex':
      return `yandexnavi://build_route_on_map?lat_to=${lat}&lon_to=${lng}`;
    case 'google':
      return platform === 'ios'
        ? `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`
        : `google.navigation:q=${lat},${lng}&mode=d`;
    case 'apple':
      return platform === 'ios' ? `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d` : null;
    case 'geo':
      return platform === 'android' ? `geo:${lat},${lng}?q=${lat},${lng}` : null;
  }
}

/** Installed navigators in priority order. Apple Maps is part of iOS and needs no probe. */
export async function detectAvailableApps(
  platform: NavPlatform,
  canOpenUrl: (url: string) => Promise<boolean>,
): Promise<NavApp[]> {
  const checks = await Promise.all(
    PRIORITY.map(async (app): Promise<NavApp | null> => {
      if (app === 'apple') return platform === 'ios' ? app : null;
      const probe = PROBE[platform][app];
      if (probe === undefined) return null;
      try {
        return (await canOpenUrl(probe)) ? app : null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((app): app is NavApp => app !== null);
}
