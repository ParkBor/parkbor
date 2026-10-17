import { describe, expect, it } from 'vitest';

import { rawMapBooking, rawMapSlot, rawSlotMap } from '@/features/operator/fixtures';
import { parseSlotMap } from '@/features/operator/operatorSchemas';
import {
  nextFreeSlot,
  selectableSlots,
  validateWalkIn,
  VEHICLE_TYPES,
  WALK_IN_MIN_GAP_MS,
} from '@/features/operator/walkInForm';

const NOW = Date.parse('2026-10-17T10:00:00+05:00');
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
function slots(...raw: Record<string, unknown>[]) {
  return parseSlotMap(rawSlotMap(raw)).slots;
}
const SLOT = '11111111-2222-4333-8444-555555555555';

describe('validateWalkIn', () => {
  it('builds the request body with a normalised plate', () => {
    expect(validateWalkIn({ slotId: SLOT, plate: ' 01 a 123-bc ', vehicleType: 'CAR' })).toEqual({
      ok: true,
      payload: { slotId: SLOT, plateNumber: '01A123BC', vehicleType: 'CAR' },
    });
  });

  it('vehicle type is mandatory and must be one of CAR | TRUCK | EV | DISABLED', () => {
    expect(VEHICLE_TYPES).toEqual(['CAR', 'TRUCK', 'EV', 'DISABLED']);
    expect(validateWalkIn({ slotId: SLOT, plate: '01A123BC', vehicleType: null })).toMatchObject({ ok: false, errors: { vehicleType: 'required' } });
    expect(validateWalkIn({ slotId: SLOT, plate: '01A123BC', vehicleType: 'BUS' })).toMatchObject({ ok: false, errors: { vehicleType: 'required' } });
  });

  it('slot is mandatory and must be a uuid', () => {
    expect(validateWalkIn({ slotId: null, plate: '01A123BC', vehicleType: 'CAR' })).toMatchObject({ ok: false, errors: { slot: 'required' } });
    expect(validateWalkIn({ slotId: '../x', plate: '01A123BC', vehicleType: 'CAR' })).toMatchObject({ ok: false, errors: { slot: 'required' } });
  });

  it('plate problems come from the shared plate rules', () => {
    expect(validateWalkIn({ slotId: SLOT, plate: '', vehicleType: 'CAR' })).toMatchObject({ ok: false, errors: { plate: 'empty' } });
    expect(validateWalkIn({ slotId: SLOT, plate: 'AB', vehicleType: 'CAR' })).toMatchObject({ ok: false, errors: { plate: 'length' } });
    expect(validateWalkIn({ slotId: SLOT, plate: '01A12!BC', vehicleType: 'CAR' })).toMatchObject({ ok: false, errors: { plate: 'charset' } });
    expect(validateWalkIn({ slotId: SLOT, plate: '12345678', vehicleType: 'CAR' })).toMatchObject({ ok: false, errors: { plate: 'mix' } });
    expect(validateWalkIn({ slotId: SLOT, plate: '01Ж123BC', vehicleType: 'CAR' })).toMatchObject({ ok: false, errors: { plate: 'ascii' } });
  });

  it('reports every problem at once', () => {
    const r = validateWalkIn({ slotId: null, plate: '', vehicleType: null });
    expect(r).toEqual({ ok: false, errors: { slot: 'required', plate: 'empty', vehicleType: 'required' } });
  });
});

describe('selectableSlots / nextFreeSlot', () => {
  const list = slots(
    rawMapSlot({ id: id(), code: 'A-1', type: 'EV', status: 'FREE' }),
    rawMapSlot({ id: id(), code: 'A-2', type: 'STANDARD', status: 'OCCUPIED', current_booking: rawMapBooking() }),
    rawMapSlot({ id: id(), code: 'A-3', type: 'STANDARD', status: 'OUT_OF_SERVICE' }),
    rawMapSlot({
      id: id(),
      code: 'A-4',
      type: 'STANDARD',
      status: 'FREE',
      next_booking: rawMapBooking({ status: 'CONFIRMED', start: new Date(NOW + WALK_IN_MIN_GAP_MS - 60_000).toISOString().replace('Z', '+00:00') }),
    }),
    rawMapSlot({ id: id(), code: 'A-5', type: 'STANDARD', status: 'FREE' }),
    rawMapSlot({ id: id(), code: 'L-1', type: 'LARGE', status: 'FREE' }),
  );

  it('only FREE slots whose type fits the vehicle and with no booking starting within 15 minutes', () => {
    expect(selectableSlots(list, 'CAR', NOW).map((s) => s.code)).toEqual(['A-5']);
    expect(selectableSlots(list, 'TRUCK', NOW).map((s) => s.code)).toEqual(['L-1']);
    expect(selectableSlots(list, 'EV', NOW).map((s) => s.code)).toEqual(['A-1', 'A-5']);
  });

  it('without a vehicle type every FREE slot with a safe gap is offered', () => {
    expect(selectableSlots(list, null, NOW).map((s) => s.code)).toEqual(['A-1', 'A-5', 'L-1']);
  });

  it('nextFreeSlot is the first selectable slot, or null', () => {
    expect(nextFreeSlot(list, 'CAR', NOW)?.code).toBe('A-5');
    expect(nextFreeSlot(list, 'DISABLED', NOW)?.code).toBe('A-5');
    expect(nextFreeSlot([], 'CAR', NOW)).toBeNull();
  });

  it('a booking that starts later than the gap does not block the slot', () => {
    const far = slots(rawMapSlot({ id: id(), code: 'F-1', status: 'FREE', next_booking: rawMapBooking({ status: 'CONFIRMED', start: '2026-10-17T15:00:00+05:00' }) }));
    expect(selectableSlots(far, 'CAR', NOW)).toHaveLength(1);
  });
});
