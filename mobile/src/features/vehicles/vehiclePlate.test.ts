import { describe, expect, it } from 'vitest';

import { formatPlate, isStandardUzPlate, normalizePlate, validatePlate } from '@/features/vehicles/vehiclePlate';

describe('normalizePlate', () => {
  it('upper-cases and strips spaces, dashes and tabs', () => {
    expect(normalizePlate(' 01 a-123 bc ')).toBe('01A123BC');
    expect(normalizePlate('01\tA\n123  BC')).toBe('01A123BC');
  });

  it('does not strip other characters (validation reports them)', () => {
    expect(normalizePlate('01A.123BC')).toBe('01A.123BC');
  });
});

describe('validatePlate', () => {
  it('accepts the Uzbek layouts and foreign plates of 5-12 mixed characters', () => {
    for (const raw of ['01 A 123 BC', '01123abc', '01A1234', 'AB1234', 'B1234', 'ABC123DEF456']) {
      const result = validatePlate(raw);
      expect(result.ok, raw).toBe(true);
    }
    expect(validatePlate('01 a 123 bc')).toEqual({ ok: true, plate: '01A123BC' });
  });

  it('rejects non-ASCII letters (Cyrillic look-alikes)', () => {
    expect(validatePlate('01А123ВС')).toEqual({ ok: false, reason: 'ascii' }); // Cyrillic А, В, С
  });

  it('rejects wrong lengths at the boundaries', () => {
    expect(validatePlate('A123')).toEqual({ ok: false, reason: 'length' });
    expect(validatePlate('A1234567890123')).toEqual({ ok: false, reason: 'length' });
    expect(validatePlate('')).toEqual({ ok: false, reason: 'length' });
    expect(validatePlate('A12345678901').ok).toBe(true); // exactly 12
  });

  it('rejects symbols and single-class plates', () => {
    expect(validatePlate('01A.123BC')).toEqual({ ok: false, reason: 'charset' });
    expect(validatePlate("01A'123")).toEqual({ ok: false, reason: 'charset' });
    expect(validatePlate('12345678')).toEqual({ ok: false, reason: 'mix' });
    expect(validatePlate('ABCDEFGH')).toEqual({ ok: false, reason: 'mix' });
  });

  it('survives hostile input without throwing', () => {
    expect(validatePlate('😀'.repeat(8)).ok).toBe(false);
    expect(validatePlate('\u0000\u0000\u0000\u0000\u00001A').ok).toBe(false);
  });
});

describe('isStandardUzPlate / formatPlate', () => {
  it('recognises the three standard layouts', () => {
    expect(isStandardUzPlate('01A123BC')).toBe(true);
    expect(isStandardUzPlate('01123ABC')).toBe(true);
    expect(isStandardUzPlate('01A1234')).toBe(true);
    expect(isStandardUzPlate('99A123BC')).toBe(false);
    expect(isStandardUzPlate('XYZ99')).toBe(false);
  });

  it('groups standard plates for display and leaves others untouched', () => {
    expect(formatPlate('01A123BC')).toBe('01 A 123 BC');
    expect(formatPlate('01123ABC')).toBe('01 123 ABC');
    expect(formatPlate('01A1234')).toBe('01 A 1234');
    expect(formatPlate('XYZ99')).toBe('XYZ99');
  });
});
