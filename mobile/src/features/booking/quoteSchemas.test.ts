import { describe, expect, it } from 'vitest';

import { rawAvailability, rawPrice } from '@/features/booking/fixtures';
import { parseAvailability, parsePrice } from '@/features/booking/quoteSchemas';
import { ContractError } from '@/lib/contract';

describe('parseAvailability', () => {
  it('maps the contract object', () => {
    expect(parseAvailability(rawAvailability())).toEqual({
      slotType: 'STANDARD',
      startMs: Date.UTC(2026, 9, 15, 9),
      endMs: Date.UTC(2026, 9, 15, 11),
      total: 20,
      available: 7,
      isOpen: true,
    });
  });

  it('allows a null slot type (all types)', () => {
    expect(parseAvailability(rawAvailability({ slot_type: null })).slotType).toBeNull();
  });

  it('rejects negative counts, available above total, unknown slot types and naive times', () => {
    for (const override of [{ total: -1 }, { available: 99 }, { slot_type: 'ROCKET' }, { start: '2026-10-15T14:00:00' }, { is_open: 'yes' }]) {
      expect(() => parseAvailability(rawAvailability(override)), JSON.stringify(override)).toThrow(ContractError);
    }
    expect(() => parseAvailability(null)).toThrow(ContractError);
  });
});

describe('parsePrice', () => {
  it('maps the contract object, money stays a string', () => {
    const price = parsePrice(rawPrice());
    expect(price.pricePerHour).toBe('6000.00');
    expect(price.total).toBe('15750.00');
    expect(price.subtotal).toBe('15000.00');
    expect(price.startMs).toBe(Date.UTC(2026, 9, 15, 9));
    expect(price.endMs).toBe(Date.UTC(2026, 9, 15, 11));
    expect(price.totalMinutes).toBe(120);
    expect(price.freeMinutes).toBe(10);
    expect(price.billedMinutes).toBe(120);
    expect(price.dynamicFactor).toBe('1.05');
    expect(price.occupancy).toBe('0.9');
    expect(price.availableSlots).toBe(3);
    expect(price.segments).toEqual([
      { startMs: Date.UTC(2026, 9, 15, 9), endMs: Date.UTC(2026, 9, 15, 10), minutes: 60, coefficient: '1.5', amount: '9000.00' },
      { startMs: Date.UTC(2026, 9, 15, 10), endMs: Date.UTC(2026, 9, 15, 11), minutes: 60, coefficient: '1', amount: '6000.00' },
    ]);
  });

  it('occupancy may be null', () => {
    expect(parsePrice(rawPrice({ occupancy: null })).occupancy).toBeNull();
  });

  it('rejects numeric money, bad segments and missing fields', () => {
    for (const override of [{ total: 15750 }, { segments: [{ minutes: 1 }] }, { segments: 'x' }, { total_minutes: -5 }, { dynamic_factor: 'abc' }]) {
      expect(() => parsePrice(rawPrice(override)), JSON.stringify(override)).toThrow(ContractError);
    }
    expect(() => parsePrice(undefined)).toThrow(ContractError);
  });
});
