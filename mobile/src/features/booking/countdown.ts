import type { BookingStatus } from '@/features/booking/bookingSchemas';
import type { Language } from '@/lib/types';

export interface CountdownSource {
  status: BookingStatus;
  startMs: number;
  endMs: number;
  holdExpiresAtMs: number | null;
}

export type CountdownKind = 'hold' | 'untilStart' | 'untilEnd' | 'none';

export interface Countdown {
  kind: CountdownKind;
  /** Never negative. */
  remainingMs: number;
  /** The target moment has passed (expired hold, overtime). */
  isOver: boolean;
}

const NONE: Countdown = { kind: 'none', remainingMs: 0, isOver: false };

function until(kind: CountdownKind, targetMs: number, nowMs: number): Countdown {
  const remaining = targetMs - nowMs;
  return { kind, remainingMs: Math.max(0, remaining), isOver: remaining <= 0 };
}

/**
 * Which timer a booking shows. `nowMs` must be the SERVER-corrected time (serverClock.now()):
 * the targets are server timestamps and the device clock may be off.
 */
export function deriveCountdown(booking: CountdownSource, nowMs: number): Countdown {
  switch (booking.status) {
    case 'PENDING_PAYMENT':
      return booking.holdExpiresAtMs === null ? NONE : until('hold', booking.holdExpiresAtMs, nowMs);
    case 'CONFIRMED':
      return nowMs < booking.startMs ? until('untilStart', booking.startMs, nowMs) : until('untilEnd', booking.endMs, nowMs);
    case 'ACTIVE':
      return until('untilEnd', booking.endMs, nowMs);
    case 'OVERSTAY':
      return { kind: 'untilEnd', remainingMs: 0, isOver: true };
    default:
      return NONE;
  }
}

const DAY_UNIT: Readonly<Record<Language, { day: string; hour: string }>> = {
  uz: { day: 'kun', hour: 'soat' },
  ru: { day: 'д', hour: 'ч' },
  en: { day: 'd', hour: 'h' },
};

const SECOND_MS = 1000;
const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;

const two = (n: number): string => String(n).padStart(2, '0');

/** "9:05" under an hour, "1:05:09" under a day, "3 d 4 h" beyond. Whole seconds, rounded up. */
export function formatRemaining(ms: number, lang: Language): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const total = Math.ceil(safe / SECOND_MS);
  if (total >= DAY_S) {
    const units = DAY_UNIT[lang];
    const days = Math.floor(total / DAY_S);
    const hours = Math.floor((total % DAY_S) / HOUR_S);
    return `${days} ${units.day} ${hours} ${units.hour}`;
  }
  const hours = Math.floor(total / HOUR_S);
  const minutes = Math.floor((total % HOUR_S) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}
