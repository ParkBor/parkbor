import { describe, expect, it } from 'vitest';

import {
  ceilToStep,
  clampDuration,
  dayLabel,
  dayStart,
  differsFromTashkent,
  defaultSelection,
  endFromDuration,
  fitsWorkingHours,
  formatClock,
  formatTashkentDate,
  startOfDay,
  startOptions,
  validatePeriod,
} from '@/features/booking/timeSlots';

const MIN = 60_000;
const HOUR = 60 * MIN;
/** 2026-10-15 14:07 in Asia/Tashkent (UTC+5). */
const NOW = Date.UTC(2026, 9, 15, 9, 7, 0);
const MIDNIGHT = Date.UTC(2026, 9, 14, 19, 0, 0); // 2026-10-15 00:00 Tashkent
const at = (h: number, m = 0): number => MIDNIGHT + h * HOUR + m * MIN;

describe('Tashkent wall clock', () => {
  it('finds local midnight regardless of the device time zone', () => {
    expect(startOfDay(NOW)).toBe(MIDNIGHT);
    expect(startOfDay(MIDNIGHT)).toBe(MIDNIGHT);
    expect(startOfDay(MIDNIGHT - 1)).toBe(MIDNIGHT - 24 * HOUR);
  });

  it('formats HH:MM in Asia/Tashkent', () => {
    expect(formatClock(NOW)).toBe('14:07');
    expect(formatClock(MIDNIGHT)).toBe('00:00');
    expect(formatClock(MIDNIGHT + 24 * HOUR - MIN)).toBe('23:59');
  });

  it('formats a day-month label', () => {
    expect(formatTashkentDate(NOW)).toEqual({ day: 15, month: 10 });
  });

  it('labels today, tomorrow and other dates', () => {
    expect(dayLabel(at(18), NOW)).toEqual({ kind: 'today', day: 15, month: 10 });
    expect(dayLabel(at(25), NOW)).toEqual({ kind: 'tomorrow', day: 16, month: 10 });
    expect(dayLabel(at(49), NOW)).toEqual({ kind: 'date', day: 17, month: 10 });
    expect(dayLabel(at(-1), NOW).kind).toBe('date');
  });
});

describe('ceilToStep', () => {
  it('rounds up to the next 15 minutes and keeps exact steps', () => {
    expect(ceilToStep(at(14, 7))).toBe(at(14, 15));
    expect(ceilToStep(at(14, 15))).toBe(at(14, 15));
    expect(ceilToStep(at(14, 0) + 1)).toBe(at(14, 15));
    expect(ceilToStep(at(23, 50))).toBe(at(24));
  });
});

describe('startOptions', () => {
  it('today starts at the next step and runs to 23:45', () => {
    const options = startOptions('today', NOW);
    expect(options[0]).toBe(at(14, 15));
    expect(options.at(-1)).toBe(at(23, 45));
    expect(options).toHaveLength(39);
  });

  it('tomorrow offers all 96 steps from 00:00', () => {
    const options = startOptions('tomorrow', NOW);
    expect(options).toHaveLength(96);
    expect(options[0]).toBe(at(24));
    expect(options[1]! - options[0]!).toBe(15 * MIN);
  });

  it('today is empty late in the evening', () => {
    expect(startOptions('today', at(23, 50))).toEqual([]);
  });

  it('dayStart gives the local midnight of the chosen day', () => {
    expect(dayStart('today', NOW)).toBe(MIDNIGHT);
    expect(dayStart('tomorrow', NOW)).toBe(MIDNIGHT + 24 * HOUR);
  });
});

describe('defaultSelection', () => {
  it('is the next step for one hour', () => {
    expect(defaultSelection(NOW)).toEqual({ startMs: at(14, 15), endMs: at(15, 15) });
  });

  it('rolls over to tomorrow 00:00 when today has no steps left', () => {
    const now = at(23, 50);
    expect(defaultSelection(now)).toEqual({ startMs: at(24), endMs: at(25) });
  });
});

describe('durations', () => {
  it('endFromDuration adds whole minutes', () => {
    expect(endFromDuration(at(14), 120)).toBe(at(16));
  });

  it('clampDuration snaps to 15 minutes within 30 min .. 24 h', () => {
    expect(clampDuration(10)).toBe(30);
    expect(clampDuration(47)).toBe(45);
    expect(clampDuration(48)).toBe(45);
    expect(clampDuration(53)).toBe(60);
    expect(clampDuration(99_999)).toBe(1440);
    expect(clampDuration(Number.NaN)).toBe(60);
  });
});

describe('validatePeriod (mirrors the server)', () => {
  const base = { startMs: at(15), endMs: at(17), nowMs: NOW, hours: null };

  it('accepts a normal period', () => {
    expect(validatePeriod(base)).toEqual({ ok: true });
  });

  it('end must be after start', () => {
    expect(validatePeriod({ ...base, endMs: base.startMs })).toEqual({ ok: false, code: 'period_invalid' });
    expect(validatePeriod({ ...base, endMs: base.startMs - HOUR })).toEqual({ ok: false, code: 'period_invalid' });
    expect(validatePeriod({ ...base, endMs: Number.NaN })).toEqual({ ok: false, code: 'period_invalid' });
  });

  it('minimum is 30 minutes inclusive', () => {
    expect(validatePeriod({ ...base, endMs: base.startMs + 29 * MIN })).toEqual({ ok: false, code: 'period_too_short' });
    expect(validatePeriod({ ...base, endMs: base.startMs + 30 * MIN }).ok).toBe(true);
  });

  it('maximum is 24 hours inclusive', () => {
    expect(validatePeriod({ ...base, endMs: base.startMs + 24 * HOUR }).ok).toBe(true);
    expect(validatePeriod({ ...base, endMs: base.startMs + 24 * HOUR + MIN })).toEqual({ ok: false, code: 'period_too_long' });
  });

  it('tolerates a start up to 5 minutes in the past, not 6', () => {
    const lateStart = NOW - 5 * MIN;
    expect(validatePeriod({ ...base, startMs: lateStart, endMs: lateStart + HOUR }).ok).toBe(true);
    const tooLate = NOW - 5 * MIN - 1000;
    expect(validatePeriod({ ...base, startMs: tooLate, endMs: tooLate + HOUR })).toEqual({ ok: false, code: 'start_in_past' });
  });

  it('allows at most 30 days ahead', () => {
    const limit = NOW + 30 * 24 * HOUR;
    expect(validatePeriod({ ...base, startMs: limit, endMs: limit + HOUR }).ok).toBe(true);
    expect(validatePeriod({ ...base, startMs: limit + MIN, endMs: limit + HOUR })).toEqual({ ok: false, code: 'too_far_ahead' });
  });

  it('flags a period outside the working hours when they are known', () => {
    const hours = { open: '08:00', close: '22:00' };
    expect(validatePeriod({ ...base, hours, startMs: at(21), endMs: at(23) })).toEqual({ ok: false, code: 'lot_closed' });
    expect(validatePeriod({ ...base, hours, startMs: at(20), endMs: at(22) }).ok).toBe(true);
  });
});

describe('fitsWorkingHours', () => {
  const day = { open: '08:00', close: '22:00' };

  it('null hours mean always open', () => {
    expect(fitsWorkingHours(null, at(3), at(5))).toBe(true);
  });

  it('open == close means 24/7', () => {
    expect(fitsWorkingHours({ open: '00:00', close: '00:00' }, at(3), at(30))).toBe(true);
  });

  it('keeps the whole period inside one window, end inclusive', () => {
    expect(fitsWorkingHours(day, at(8), at(22))).toBe(true);
    expect(fitsWorkingHours(day, at(7, 45), at(9))).toBe(false);
    expect(fitsWorkingHours(day, at(21), at(22, 15))).toBe(false);
  });

  it('supports overnight windows', () => {
    const night = { open: '22:00', close: '06:00' };
    expect(fitsWorkingHours(night, at(23), at(29))).toBe(true); // 23:00 -> 05:00
    expect(fitsWorkingHours(night, at(1), at(5))).toBe(true);
    expect(fitsWorkingHours(night, at(5), at(7))).toBe(false);
    expect(fitsWorkingHours(night, at(12), at(13))).toBe(false);
  });

  it('fails closed on half a schedule or garbage', () => {
    expect(fitsWorkingHours({ open: '08:00', close: null }, at(9), at(10))).toBe(false);
    expect(fitsWorkingHours({ open: 'xx', close: '10:00' }, at(9), at(10))).toBe(false);
  });
});

describe('differsFromTashkent', () => {
  it('is false for a device on UTC+5 and true for any other offset', () => {
    expect(differsFromTashkent(300)).toBe(false);
    expect(differsFromTashkent(0)).toBe(true);
    expect(differsFromTashkent(180)).toBe(true);
    expect(differsFromTashkent(-240)).toBe(true);
  });
});
