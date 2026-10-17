// Plain CommonJS on purpose: app.config.ts runs in Node at config time, where Expo's loader cannot
// resolve local .ts modules. Typed via mapsKey.d.ts and unit tested from src/lib/mapsKey.test.ts.

const PLACEHOLDER = 'replace-me';

/**
 * Android Google Maps key from EXPO_PUBLIC_GOOGLE_MAPS_API_KEY. Production builds must have a
 * real key (a keyless release shows a blank map); development tolerates its absence.
 * The key ends up in the app bundle/manifest: its restriction in Google Cloud is the protection.
 *
 * @param {string | undefined} value
 * @param {boolean} isProduction
 * @returns {string | undefined}
 */
function resolveGoogleMapsKey(value, isProduction) {
  const key = value === undefined ? undefined : value.trim();
  const isReal = key !== undefined && key !== '' && key !== PLACEHOLDER;
  if (isReal) return key;
  if (isProduction) {
    throw new Error('EXPO_PUBLIC_GOOGLE_MAPS_API_KEY must be set to a real key for production builds');
  }
  return undefined;
}

module.exports = { resolveGoogleMapsKey };
