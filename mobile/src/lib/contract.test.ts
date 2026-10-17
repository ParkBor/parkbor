import { describe, expect, it } from 'vitest';

import { ContractError, instantSchema, isoInstant, moneySchema, parseInstant, uuidSchema } from '@/lib/contract';

describe('parseInstant', () => {
  it('accepts ISO 8601 with a UTC offset or Z', () => {
    expect(parseInstant('2026-10-15T14:00:00+05:00')).toBe(Date.UTC(2026, 9, 15, 9, 0, 0));
    expect(parseInstant('2026-10-15T09:00:00Z')).toBe(Date.UTC(2026, 9, 15, 9, 0, 0));
    expect(parseInstant('2026-10-15T09:00:00.250Z')).toBe(Date.UTC(2026, 9, 15, 9, 0, 0, 250));
    expect(parseInstant('2026-10-15T14:00-05:00')).toBe(Date.UTC(2026, 9, 15, 19, 0, 0));
  });

  it('rejects naive, date-only, malformed and non-string values', () => {
    for (const bad of ['2026-10-15T14:00:00', '2026-10-15', 'yesterday', '', '2026-13-45T10:00:00Z', null, 5, undefined, {}]) {
      expect(parseInstant(bad), String(bad)).toBeNull();
    }
  });
});

describe('isoInstant', () => {
  it('writes UTC with seconds and no fraction (no "+" to encode)', () => {
    expect(isoInstant(Date.UTC(2026, 9, 15, 9, 0, 0, 999))).toBe('2026-10-15T09:00:00Z');
  });

  it('throws on a non-finite value', () => {
    expect(() => isoInstant(Number.NaN)).toThrow(RangeError);
  });
});

describe('schemas', () => {
  it('instantSchema yields epoch milliseconds', () => {
    expect(instantSchema.parse('2026-10-15T09:00:00Z')).toBe(Date.UTC(2026, 9, 15, 9));
    expect(instantSchema.safeParse('2026-10-15T09:00:00').success).toBe(false);
  });

  it('moneySchema accepts decimal strings only', () => {
    expect(moneySchema.parse('12000.00')).toBe('12000.00');
    for (const bad of [12000, '-1', '1e3', '', '12,5', '1.2.3']) {
      expect(moneySchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('uuidSchema accepts UUIDs only', () => {
    expect(uuidSchema.safeParse('b2f0c1de-1111-4222-8333-444455556666').success).toBe(true);
    expect(uuidSchema.safeParse('../etc/passwd').success).toBe(false);
  });
});

describe('ContractError', () => {
  it('names the contract but never carries response content', () => {
    const error = new ContractError('booking');
    expect(error.name).toBe('ContractError');
    expect(error.message).toBe('Invalid booking response');
  });
});
