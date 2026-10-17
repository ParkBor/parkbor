import { describe, expect, it } from 'vitest';

import { describeWhen } from '@/features/booking/whenText';

const HOUR = 3_600_000;
/** 2026-10-15 14:07 Asia/Tashkent. */
const NOW = Date.UTC(2026, 9, 15, 9, 7, 0);
const MIDNIGHT = Date.UTC(2026, 9, 14, 19, 0, 0);
const at = (h: number, m = 0): number => MIDNIGHT + h * HOUR + m * 60_000;

describe('describeWhen', () => {
  it('today, same-day period', () => {
    expect(describeWhen(at(15), at(17), NOW)).toEqual({
      dayKind: 'today',
      dateText: '15.10',
      from: '15:00',
      to: '17:00',
      endsNextDay: false,
    });
  });

  it('tomorrow', () => {
    expect(describeWhen(at(24 + 9), at(24 + 10), NOW).dayKind).toBe('tomorrow');
  });

  it('a later date shows dd.MM and zero-pads', () => {
    expect(describeWhen(Date.UTC(2026, 0, 4, 5), Date.UTC(2026, 0, 4, 6), Date.UTC(2026, 0, 1)).dateText).toBe('04.01');
  });

  it('flags a period that ends after midnight', () => {
    const result = describeWhen(at(23), at(25), NOW);
    expect(result.endsNextDay).toBe(true);
    expect(result.to).toBe('01:00');
  });

  it('a period ending exactly at midnight is not "next day"', () => {
    expect(describeWhen(at(22), at(24), NOW).endsNextDay).toBe(false);
  });
});
