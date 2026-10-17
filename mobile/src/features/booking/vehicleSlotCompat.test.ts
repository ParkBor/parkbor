import { describe, expect, it } from 'vitest';

import { allowedSlotTypes, checkVehicleSlot, defaultSlotType } from '@/features/booking/vehicleSlotCompat';

describe('vehicle / slot compatibility (mirror of backend compat.py)', () => {
  it('lists allowed slot types per vehicle type', () => {
    expect(allowedSlotTypes('CAR')).toEqual(['STANDARD']);
    expect(allowedSlotTypes('TRUCK')).toEqual(['LARGE']);
    expect(allowedSlotTypes('EV')).toEqual(['EV', 'STANDARD']);
    expect(allowedSlotTypes('DISABLED')).toEqual(['DISABLED', 'STANDARD']);
  });

  it('unknown vehicle types allow nothing (the server decides)', () => {
    expect(allowedSlotTypes('SPACESHIP')).toEqual([]);
  });

  it('checkVehicleSlot is true only for allowed pairs', () => {
    expect(checkVehicleSlot('CAR', 'STANDARD')).toBe(true);
    expect(checkVehicleSlot('CAR', 'EV')).toBe(false);
    expect(checkVehicleSlot('CAR', 'LARGE')).toBe(false);
    expect(checkVehicleSlot('TRUCK', 'STANDARD')).toBe(false);
    expect(checkVehicleSlot('EV', 'STANDARD')).toBe(true);
    expect(checkVehicleSlot('DISABLED', 'DISABLED')).toBe(true);
    expect(checkVehicleSlot('DISABLED', 'EV')).toBe(false);
  });

  it('defaultSlotType picks the first allowed type, STANDARD as a fallback', () => {
    expect(defaultSlotType('TRUCK')).toBe('LARGE');
    expect(defaultSlotType('EV')).toBe('EV');
    expect(defaultSlotType('CAR')).toBe('STANDARD');
    expect(defaultSlotType(null)).toBe('STANDARD');
    expect(defaultSlotType('SPACESHIP')).toBe('STANDARD');
  });
});
