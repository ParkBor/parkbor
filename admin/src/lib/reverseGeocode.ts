import { safeText } from './format'

// Address autofill from the picked map point (Nominatim reverse geocoding).
//
// OSM usage policy (https://operations.osmfoundation.org/policies/nominatim/): max 1 request per
// second, no bulk use, no autocomplete-while-typing; the browser sends an identifying Referer.
// We ask once per finished map pick (debounced by the caller), cancel the previous request, and
// never retry. The picked coordinates are sent to OSM (privacy: stated in docs/ARCHITECTURE.md 14).
// shortcut: the public server is fine for a few owners adding lots; for real traffic use our own
// Nominatim or a backend proxy (and then change connect-src in the CRM CSP).

export const NOMINATIM_REVERSE_URL = 'https://nominatim.openstreetmap.org/reverse'
export const GEOCODE_TIMEOUT_MS = 8_000
export const MAX_ADDRESS_LENGTH = 300
const NAME_MAX = 120

export interface GeocodeOptions {
  /** UI language (uz | ru | en), sent as accept-language. */
  language: string
  /** Cancels the request (a newer pick replaces it). */
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const LOCALITY_KEYS = ['suburb', 'city_district', 'neighbourhood', 'city', 'town', 'village'] as const

function text(value: unknown): string {
  return typeof value === 'string' ? safeText(value, NAME_MAX).trim() : ''
}

/**
 * Strict parse of a Nominatim reverse response. Prefers "road house_number, locality" built from
 * `address`; falls back to the first three parts of `display_name`. Anything else -> null.
 */
export function parseAddress(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  const parts =
    typeof record.address === 'object' && record.address !== null
      ? (record.address as Record<string, unknown>)
      : {}
  const road = [text(parts.road), text(parts.house_number)].filter(Boolean).join(' ')
  const locality = LOCALITY_KEYS.map((key) => text(parts[key])).find(Boolean) ?? ''
  const built = [road, locality].filter(Boolean).join(', ')
  if (road) return safeText(built, MAX_ADDRESS_LENGTH)
  if (typeof record.display_name !== 'string') return built ? safeText(built, MAX_ADDRESS_LENGTH) : null
  const short = safeText(record.display_name, MAX_ADDRESS_LENGTH * 2)
    .split(',')
    .slice(0, 3)
    .join(',')
    .trim()
  return short ? safeText(short, MAX_ADDRESS_LENGTH) : null
}

export function buildReverseUrl(lat: number, lng: number, language: string): string {
  const query = new URLSearchParams({
    format: 'jsonv2',
    lat: String(lat),
    lon: String(lng),
    zoom: '18',
    'accept-language': language,
  })
  return `${NOMINATIM_REVERSE_URL}?${query.toString()}`
}

/** A readable address for the point, or null on ANY failure (the user then types it). */
export async function reverseGeocode(
  lat: number,
  lng: number,
  { language, signal, timeoutMs = GEOCODE_TIMEOUT_MS, fetchImpl }: GeocodeOptions,
): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abort, { once: true })
  try {
    const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
    const response = await doFetch(buildReverseUrl(lat, lng, language), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'strict-origin-when-cross-origin',
    })
    if (!response.ok) return null
    return parseAddress(await response.json())
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
