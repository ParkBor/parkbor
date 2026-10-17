import { dayLabel, formatClock, startOfDay } from '@/features/booking/timeSlots';

export interface WhenParts {
  dayKind: 'today' | 'tomorrow' | 'date';
  /** "15.10" (dd.MM, Asia/Tashkent). */
  dateText: string;
  from: string;
  to: string;
  /** The end falls on a later day than the start (not counting an end exactly at midnight). */
  endsNextDay: boolean;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** Language-neutral pieces of "Today, 15:00 — 17:00"; the screen adds the translated day word. */
export function describeWhen(startMs: number, endMs: number, nowMs: number): WhenParts {
  const label = dayLabel(startMs, nowMs);
  return {
    dayKind: label.kind,
    dateText: `${two(label.day)}.${two(label.month)}`,
    from: formatClock(startMs),
    to: formatClock(endMs),
    endsNextDay: startOfDay(endMs - 1) !== startOfDay(startMs),
  };
}
