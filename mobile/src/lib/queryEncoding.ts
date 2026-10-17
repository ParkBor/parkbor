type QueryValue = string | number | boolean | null | undefined;

/**
 * Query string with strict percent-encoding. `encodeURIComponent` turns the "+" of a UTC offset
 * into %2B (a raw "+" would be decoded by the server as a space and rejected with 400), and
 * ":" into %3A. Undefined / null values are skipped. Used as the axios `paramsSerializer` so the
 * wire format does not depend on the HTTP library's defaults.
 */
export function buildQueryString(params: Readonly<Record<string, QueryValue>>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}
