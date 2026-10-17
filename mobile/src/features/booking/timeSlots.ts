// Booking period arithmetic. Everything is epoch milliseconds; wall-clock reasoning is done in
// Asia/Tashkent (UTC+5, no DST) because that is the time the lot's working hours and tariffs
// are defined in - NOT the device's zone. Server rules: ARCHITECTURE 10.8 "Davomiylik va moslik".

export const STEP_MIN = 15;
export const MIN_DURATION_MIN = 30;
export const MAX_DURATION_MIN = 24 * 60;
export const DEFAULT_DURATION_MIN = 60;
export const QUICK_DURATIONS_MIN: readonly number[] = [60, 120, 180];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const STEP_MS = STEP_MIN * MINUTE_MS;
/** Asia/Tashkent is UTC+5 all year (no DST since 1991). */
const TASHKENT_OFFSET_MS = 5 * HOUR_MS;
/** Server: start >= now - 5 min. */
export const PAST_TOLERANCE_MS = 5 * MINUTE_MS;
/** Server: start <= now + 30 days. */
export const MAX_AHEAD_MS = 30 * DAY_MS;

export type DayChoice = 'today' | 'tomorrow';

export interface WorkingHours {
  /** "HH:MM" (Asia/Tashkent). */
  open: string | null;
  close: string | null;
}

export interface Selection {
  startMs: number;
  endMs: number;
}

export type PeriodProblem =
  | 'period_invalid'
  | 'period_too_short'
  | 'period_too_long'
  | 'start_in_past'
  | 'too_far_ahead'
  | 'lot_closed';

export type PeriodCheck = { ok: true } | { ok: false; code: PeriodProblem };

export interface PeriodInput {
  startMs: number;
  endMs: number;
  nowMs: number;
  /** Known working hours, or null when the API does not expose them (the server still decides). */
  hours: WorkingHours | null;
}

/** True when the device zone (offset east of UTC in minutes, i.e. -getTimezoneOffset()) is not UTC+5. */
export function differsFromTashkent(deviceOffsetMin: number): boolean {
  return deviceOffsetMin !== TASHKENT_OFFSET_MS / MINUTE_MS;
}

/** Local (Tashkent) midnight at or before `ms`. */
export function startOfDay(ms: number): number {
  return Math.floor((ms + TASHKENT_OFFSET_MS) / DAY_MS) * DAY_MS - TASHKENT_OFFSET_MS;
}

function minutesIntoDay(ms: number): number {
  return Math.round((ms - startOfDay(ms)) / MINUTE_MS);
}

/** "14:07" in Asia/Tashkent. */
export function formatClock(ms: number): string {
  const minutes = minutesIntoDay(ms);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatTashkentDate(ms: number): { day: number; month: number } {
  const local = new Date(ms + TASHKENT_OFFSET_MS);
  return { day: local.getUTCDate(), month: local.getUTCMonth() + 1 };
}

export interface DayLabel {
  kind: 'today' | 'tomorrow' | 'date';
  day: number;
  month: number;
}

export function dayLabel(ms: number, nowMs: number): DayLabel {
  const diffDays = Math.round((startOfDay(ms) - startOfDay(nowMs)) / DAY_MS);
  const kind = diffDays === 0 ? 'today' : diffDays === 1 ? 'tomorrow' : 'date';
  return { kind, ...formatTashkentDate(ms) };
}

/** Next 15-minute boundary at or after `ms`. (+5 h is a multiple of 15 min, so UTC steps match.) */
export function ceilToStep(ms: number): number {
  return Math.ceil(ms / STEP_MS) * STEP_MS;
}

export function dayStart(choice: DayChoice, nowMs: number): number {
  const today = startOfDay(nowMs);
  return choice === 'today' ? today : today + DAY_MS;
}

/** Selectable start times of a day: 15-minute steps; for today only from the next step on. */
export function startOptions(choice: DayChoice, nowMs: number): number[] {
  const begin = dayStart(choice, nowMs);
  const end = begin + DAY_MS;
  const first = choice === 'today' ? Math.max(begin, ceilToStep(nowMs)) : begin;
  const options: number[] = [];
  for (let t = first; t < end; t += STEP_MS) options.push(t);
  return options;
}

export function endFromDuration(startMs: number, durationMin: number): number {
  return startMs + durationMin * MINUTE_MS;
}

/** Snap to the 15-minute grid and into 30 min .. 24 h; NaN falls back to one hour. */
export function clampDuration(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_DURATION_MIN;
  const snapped = Math.round(minutes / STEP_MIN) * STEP_MIN;
  return Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, snapped));
}

/** Next step for one hour; tomorrow 00:00 when today has no step left. */
export function defaultSelection(nowMs: number): Selection {
  const first = startOptions('today', nowMs)[0] ?? dayStart('tomorrow', nowMs);
  return { startMs: first, endMs: endFromDuration(first, DEFAULT_DURATION_MIN) };
}

function toMinutes(clock: string | null): number | null {
  if (clock === null) return null;
  const match = /^(\d{2}):(\d{2})/.exec(clock);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Mirror of the server's `fits_working_hours`. The API does not expose open/close times yet, so
 * callers pass `hours: null` today (always fits; the server and availability.is_open decide). Kept
 * (tested) so the pre-check switches on as soon as the lot payload carries the hours.
 *: the whole period must lie inside ONE opening
 * window, the closing instant is inclusive for the END; open == close or no hours = 24/7;
 * `open > close` is an overnight window; half a schedule (or garbage) fails closed.
 */
export function fitsWorkingHours(hours: WorkingHours | null, startMs: number, endMs: number): boolean {
  if (hours === null) return true;
  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  if ((open === null) !== (close === null)) return false;
  if (open === null || close === null) return true;
  if (Number.isNaN(open) || Number.isNaN(close)) return false;
  if (open === close) return true;

  const day = startOfDay(startMs);
  const clock = minutesIntoDay(startMs);
  const at = (base: number, minutes: number): number => base + minutes * MINUTE_MS;
  let windowStart: number;
  let windowEnd: number;
  if (open < close) {
    windowStart = at(day, open);
    windowEnd = at(day, close);
  } else if (clock >= open) {
    windowStart = at(day, open);
    windowEnd = at(day + DAY_MS, close);
  } else if (clock < close) {
    windowStart = at(day - DAY_MS, open);
    windowEnd = at(day, close);
  } else {
    return false;
  }
  return windowStart <= startMs && endMs <= windowEnd;
}

/** Same checks, same order and same codes as the server, so the client can warn before sending. */
export function validatePeriod({ startMs, endMs, nowMs, hours }: PeriodInput): PeriodCheck {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return { ok: false, code: 'period_invalid' };
  }
  const duration = endMs - startMs;
  if (duration < MIN_DURATION_MIN * MINUTE_MS) return { ok: false, code: 'period_too_short' };
  if (duration > MAX_DURATION_MIN * MINUTE_MS) return { ok: false, code: 'period_too_long' };
  if (startMs < nowMs - PAST_TOLERANCE_MS) return { ok: false, code: 'start_in_past' };
  if (startMs > nowMs + MAX_AHEAD_MS) return { ok: false, code: 'too_far_ahead' };
  if (!fitsWorkingHours(hours, startMs, endMs)) return { ok: false, code: 'lot_closed' };
  return { ok: true };
}
