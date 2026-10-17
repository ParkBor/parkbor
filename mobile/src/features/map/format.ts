import type { Language } from '@/lib/types';

const NBSP = ' ';

interface Locale {
  decimal: string;
  group: string;
  meter: string;
  kilometer: string;
  hour: string;
  minute: string;
  currency: string;
  perHour: string;
}

// Units are locale data (like number separators), kept next to the formatters so they can be
// tested for all three languages without a React/i18n runtime.
const LOCALES: Readonly<Record<Language, Locale>> = {
  uz: { decimal: ',', group: NBSP, meter: 'm', kilometer: 'km', hour: 'soat', minute: 'dq', currency: 'so‘m', perHour: '/soat' },
  ru: { decimal: ',', group: NBSP, meter: 'м', kilometer: 'км', hour: 'ч', minute: 'мин', currency: 'сум', perHour: '/ч' },
  en: { decimal: '.', group: ',', meter: 'm', kilometer: 'km', hour: 'h', minute: 'min', currency: 'UZS', perHour: '/h' },
};

const METERS_PER_KM = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const PRICE_PATTERN = /^(\d+)(?:\.(\d+))?$/;

function groupDigits(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** "350 m" below 1 km, otherwise "1.2 km" (one decimal, trailing zero dropped). */
export function formatDistance(meters: number, lang: Language): string {
  const l = LOCALES[lang];
  const safe = Number.isFinite(meters) && meters > 0 ? meters : 0;
  const rounded = Math.round(safe);
  if (rounded < METERS_PER_KM) return `${rounded}${NBSP}${l.meter}`;
  const tenths = Math.round(safe / (METERS_PER_KM / 10));
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  const number = fraction === 0 ? `${whole}` : `${whole}${l.decimal}${fraction}`;
  return `${number}${NBSP}${l.kilometer}`;
}

/** Whole minutes, rounded up (at least 1): "12 min" or "1 h 5 min". */
export function formatDuration(seconds: number | null, lang: Language): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const l = LOCALES[lang];
  const totalMinutes = Math.max(1, Math.ceil(seconds / SECONDS_PER_MINUTE));
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  const hourPart = `${hours}${NBSP}${l.hour}`;
  const minutePart = `${minutes}${NBSP}${l.minute}`;
  if (hours === 0) return minutePart;
  return minutes === 0 ? hourPart : `${hourPart} ${minutePart}`;
}

/** Decimal string -> "12 000 so'm". Exact (BigInt), rounds the fraction half up; null if malformed. */
export function formatPrice(price: string | null, lang: Language): string | null {
  if (price === null) return null;
  const match = PRICE_PATTERN.exec(price);
  if (!match) return null;
  const l = LOCALES[lang];
  const roundUp = (match[2]?.charAt(0) ?? '0') >= '5';
  const amount = BigInt(match[1] ?? '0') + (roundUp ? 1n : 0n);
  return `${groupDigits(amount.toString(), l.group)}${NBSP}${l.currency}`;
}

export function formatPricePerHour(price: string | null, lang: Language): string | null {
  const formatted = formatPrice(price, lang);
  return formatted === null ? null : `${formatted}${LOCALES[lang].perHour}`;
}

export function formatRating(rating: number | null, lang: Language): string | null {
  if (rating === null || !Number.isFinite(rating)) return null;
  return rating.toFixed(1).replace('.', LOCALES[lang].decimal);
}
