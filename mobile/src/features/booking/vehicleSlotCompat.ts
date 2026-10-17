import type { SlotType } from '@/features/map/schemas';

// Mirror of backend compat.py: CAR->STANDARD; TRUCK->LARGE; EV->EV|STANDARD; DISABLED->DISABLED|STANDARD.
// EV / DISABLED / LARGE slots are reserved for their own vehicles. The server decides
// (422 vehicle_slot_mismatch); this only warns before the request.
const COMPAT: Readonly<Record<string, readonly SlotType[]>> = {
  CAR: ['STANDARD'],
  TRUCK: ['LARGE'],
  EV: ['EV', 'STANDARD'],
  DISABLED: ['DISABLED', 'STANDARD'],
};

export function allowedSlotTypes(vehicleType: string): readonly SlotType[] {
  return Object.hasOwn(COMPAT, vehicleType) ? (COMPAT[vehicleType] ?? []) : [];
}

export function checkVehicleSlot(vehicleType: string, slotType: SlotType): boolean {
  return allowedSlotTypes(vehicleType).includes(slotType);
}

export function defaultSlotType(vehicleType: string | null): SlotType {
  return (vehicleType === null ? undefined : allowedSlotTypes(vehicleType)[0]) ?? 'STANDARD';
}
