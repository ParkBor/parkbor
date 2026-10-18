// Filters are picked as calendar days and sent as offset-aware instants in Asia/Tashkent
// (UTC+5, no daylight saving). The server stores UTC.

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/

function isRealDay(value: string): boolean {
  const match = YMD.exec(value)
  if (!match) return false
  const [, y, m, d] = match.map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

export function tashkentDayStart(ymd: string): string | undefined {
  return isRealDay(ymd) ? `${ymd}T00:00:00+05:00` : undefined
}

/**
 * EXCLUSIVE upper bound for a picked last day: the start of the NEXT Tashkent day. Filters send
 * it as `to` and the backend filters `value < to`, while `from` is inclusive (`value >= from`).
 */
export function tashkentNextDayStart(ymd: string): string | undefined {
  return isRealDay(ymd) ? `${addDays(ymd, 1)}T00:00:00+05:00` : undefined
}

export type DayRange = [string, string] | null

/** `{from, to}` query parameters for a picked day range; missing / malformed ends are left out. */
export function toRangeParams(range: DayRange): { from?: string; to?: string } {
  if (!range) return {}
  const from = tashkentDayStart(range[0])
  const to = tashkentNextDayStart(range[1])
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) }
}

const MS_PER_DAY = 86_400_000

/** Today's calendar day in Asia/Tashkent as YYYY-MM-DD (en-CA formats as ISO). */
export function tashkentToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** Calendar arithmetic on YYYY-MM-DD strings (UTC maths, so no daylight-saving surprises). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY).toISOString().slice(0, 10)
}
