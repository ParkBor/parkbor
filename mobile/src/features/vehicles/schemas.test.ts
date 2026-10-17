import { describe, expect, it } from 'vitest';

import { ContractError } from '@/lib/contract';
import {
  parseVehicle,
  parseVehicleList,
  toVehicleBody,
  validateVehicleForm,
  VEHICLE_TYPES,
} from '@/features/vehicles/schemas';

const ID = 'a91c1de0-1111-4222-8333-444455556666';
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  plate_number: '01A123BC',
  type: 'CAR',
  created_at: '2026-10-15T13:10:00+05:00',
  ...overrides,
});

describe('parseVehicle', () => {
  it('maps the contract object', () => {
    expect(parseVehicle(raw())).toEqual({ id: ID, plateNumber: '01A123BC', type: 'CAR' });
  });

  it('knows the four documented types', () => {
    expect([...VEHICLE_TYPES]).toEqual(['CAR', 'TRUCK', 'EV', 'DISABLED']);
    for (const type of VEHICLE_TYPES) expect(parseVehicle(raw({ type })).type).toBe(type);
  });

  it('rejects unknown types, bad ids and non-string plates', () => {
    expect(() => parseVehicle(raw({ type: 'BOAT' }))).toThrow(ContractError);
    expect(() => parseVehicle(raw({ id: '1' }))).toThrow(ContractError);
    expect(() => parseVehicle(raw({ plate_number: 7 }))).toThrow(ContractError);
    expect(() => parseVehicle(null)).toThrow(ContractError);
  });
});

describe('parseVehicleList', () => {
  it('parses an unpaginated array', () => {
    expect(parseVehicleList([raw(), raw({ id: 'b91c1de0-1111-4222-8333-444455556666', plate_number: 'B1234AB' })])).toHaveLength(2);
  });

  it('drops malformed items, rejects when nothing is valid', () => {
    expect(parseVehicleList([raw(), { broken: true }])).toHaveLength(1);
    expect(() => parseVehicleList([{ broken: true }])).toThrow(ContractError);
  });

  it('an empty list is fine; a non-array is not', () => {
    expect(parseVehicleList([])).toEqual([]);
    expect(() => parseVehicleList({ results: [] })).toThrow(ContractError);
  });
});

describe('validateVehicleForm', () => {
  it('normalises the plate and accepts a type', () => {
    expect(validateVehicleForm({ plate: ' 01 a 123 bc ', type: 'EV' })).toEqual({
      ok: true,
      value: { plate: '01A123BC', type: 'EV' },
    });
  });

  it('reports field errors as i18n keys', () => {
    expect(validateVehicleForm({ plate: '', type: 'CAR' })).toEqual({
      ok: false,
      errors: { plate: 'vehicles.validation.plateLength' },
    });
    expect(validateVehicleForm({ plate: '01А123ВС', type: 'CAR' })).toEqual({
      ok: false,
      errors: { plate: 'vehicles.validation.plateAscii' },
    });
    expect(validateVehicleForm({ plate: '123456', type: 'CAR' })).toEqual({
      ok: false,
      errors: { plate: 'vehicles.validation.plateMix' },
    });
    expect(validateVehicleForm({ plate: '01A#23BC', type: 'CAR' })).toEqual({
      ok: false,
      errors: { plate: 'vehicles.validation.plateCharset' },
    });
  });

  it('rejects a missing or unknown type', () => {
    expect(validateVehicleForm({ plate: '01A123BC', type: '' })).toEqual({
      ok: false,
      errors: { type: 'vehicles.validation.typeRequired' },
    });
    expect(validateVehicleForm({ plate: '01A123BC', type: 'BOAT' }).ok).toBe(false);
  });

  it('reports both fields at once', () => {
    const result = validateVehicleForm({ plate: '', type: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(['plate', 'type']);
  });
});

describe('toVehicleBody', () => {
  it('sends the normalised plate and the type (PUT requires type)', () => {
    expect(toVehicleBody({ plate: '01A123BC', type: 'DISABLED' })).toEqual({ plate_number: '01A123BC', type: 'DISABLED' });
  });
});
