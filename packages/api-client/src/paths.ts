/** Percent-encode an id for use as ONE path segment ('.'/'..' would still traverse). */
export function seg(id: string): string {
  if (!id || id === '.' || id === '..') throw new TypeError('Invalid resource id')
  return encodeURIComponent(id)
}
