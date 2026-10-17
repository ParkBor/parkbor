import type { Price } from '@/features/booking/quoteSchemas';
import { formatDuration, formatPrice, formatPricePerHour } from '@/features/map/format';
import type { Language } from '@/lib/types';

const MONEY = /^(\d+)(?:\.(\d+))?$/;
const CENT_DIGITS = 2;

function toCents(value: string): bigint | null {
  const match = MONEY.exec(value);
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(CENT_DIGITS, '0').slice(0, CENT_DIGITS);
  return BigInt(match[1] ?? '0') * 100n + BigInt(fraction);
}

/** Exact decimal subtraction on strings ("15750.00" - "15000.00" = "750.00"); null if malformed. */
export function subtractMoney(a: string, b: string): string | null {
  const left = toCents(a);
  const right = toCents(b);
  if (left === null || right === null) return null;
  const diff = left - right;
  const sign = diff < 0n ? '-' : '';
  const abs = diff < 0n ? -diff : diff;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(CENT_DIGITS, '0');
  return `${sign}${whole}.${cents}`;
}

export interface PriceRow {
  kind: 'segment' | 'dynamic';
  /** i18n interpolation values. */
  params: Record<string, string>;
  /** Peak / non-base coefficient: highlighted and labelled "peak". */
  isPeak: boolean;
  /** Formatted money. */
  amount: string;
}

export interface PriceView {
  rows: PriceRow[];
  freeMinutes: number;
  perHour: string | null;
  total: string;
}

function trimCoefficient(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

function isUnit(coefficient: string): boolean {
  return Number(coefficient) === 1;
}

/**
 * The server's own breakdown, shown as returned: segments with their amounts, the dynamic
 * (occupancy) surcharge as the exact difference total - subtotal, and the server total.
 * Nothing is recomputed in floats; the total is indicative - the amount is fixed on creation.
 */
export function derivePriceRows(price: Price, lang: Language): PriceView {
  const rows: PriceRow[] = price.segments.map((segment) => ({
    kind: 'segment',
    params: {
      duration: formatDuration(segment.minutes * 60, lang) ?? '',
      coefficient: trimCoefficient(segment.coefficient),
    },
    isPeak: !isUnit(segment.coefficient),
    amount: formatPrice(segment.amount, lang) ?? segment.amount,
  }));
  if (!isUnit(price.dynamicFactor)) {
    const surcharge = subtractMoney(price.total, price.subtotal);
    const formatted = surcharge === null ? null : formatPrice(surcharge, lang);
    if (formatted !== null) {
      rows.push({ kind: 'dynamic', params: { factor: trimCoefficient(price.dynamicFactor) }, isPeak: false, amount: formatted });
    }
  }
  return {
    rows,
    freeMinutes: price.freeMinutes,
    perHour: formatPricePerHour(price.pricePerHour, lang),
    total: formatPrice(price.total, lang) ?? price.total,
  };
}
