import { describe, expect, it } from 'vitest';

import { rawPrice } from '@/features/booking/fixtures';
import { derivePriceRows, subtractMoney } from '@/features/booking/priceRows';
import { parsePrice } from '@/features/booking/quoteSchemas';

const nb = (text: string): string => text.replaceAll(' ', String.fromCharCode(160));

describe('subtractMoney', () => {
  it('is exact (no float drift)', () => {
    expect(subtractMoney('15750.00', '15000.00')).toBe('750.00');
    expect(subtractMoney('0.30', '0.10')).toBe('0.20');
    expect(subtractMoney('10.00', '10.00')).toBe('0.00');
  });

  it('can go negative and handles uneven decimals', () => {
    expect(subtractMoney('10', '10.5')).toBe('-0.50');
    expect(subtractMoney('1.5', '0.25')).toBe('1.25');
  });

  it('returns null for malformed money', () => {
    expect(subtractMoney('abc', '1.00')).toBeNull();
    expect(subtractMoney('1.00', '')).toBeNull();
  });
});

describe('derivePriceRows', () => {
  it('lists server segments, free minutes, the dynamic surcharge and the server total', () => {
    const view = derivePriceRows(parsePrice(rawPrice()), 'en');
    expect(view.rows).toEqual([
      { kind: 'segment', params: { duration: nb('1 h'), coefficient: '1.5' }, isPeak: true, amount: nb('9,000 UZS') },
      { kind: 'segment', params: { duration: nb('1 h'), coefficient: '1' }, isPeak: false, amount: nb('6,000 UZS') },
      { kind: 'dynamic', params: { factor: '1.05' }, isPeak: false, amount: nb('750 UZS') },
    ]);
    expect(view.freeMinutes).toBe(10);
    expect(view.total).toBe(nb('15,750 UZS'));
    expect(view.perHour).toBe(nb('6,000 UZS/h'));
  });

  it('omits the dynamic row when the factor is 1', () => {
    const view = derivePriceRows(
      parsePrice(rawPrice({ dynamic_factor: '1', total: '15000.00' })),
      'uz',
    );
    expect(view.rows.some((r) => r.kind === 'dynamic')).toBe(false);
    expect(view.total).toBe(nb('15 000 so‘m'));
  });

  it('formats a unit coefficient without a decimal tail', () => {
    const view = derivePriceRows(parsePrice(rawPrice({ segments: [{ start: '2026-10-15T14:00:00+05:00', end: '2026-10-15T15:00:00+05:00', minutes: 60, coefficient: '1.0000', amount: '6000.00' }] })), 'en');
    expect(view.rows[0]?.params.coefficient).toBe('1');
    expect(view.rows[0]?.isPeak).toBe(false);
  });

  it('shows the server total even when sub-amounts are inconsistent (never recomputes)', () => {
    const view = derivePriceRows(parsePrice(rawPrice({ total: '99999.00' })), 'en');
    expect(view.total).toBe(nb('99,999 UZS'));
  });
});
