import { allowedSlotTypes } from '@/features/booking/vehicleSlotCompat';
import type { MapSlot } from '@/features/operator/operatorSchemas';
import { isUuid } from '@/lib/contract';
import { validatePlate, type PlateProblem } from '@/features/vehicles/vehiclePlate';

export const VEHICLE_TYPES = ['CAR', 'TRUCK', 'EV', 'DISABLED'] as const;
export type WalkInVehicleType = (typeof VEHICLE_TYPES)[number];

/** The server refuses a walk-in when a booking starts on the slot within 15 minutes (slot_reserved_soon). */
export const WALK_IN_MIN_GAP_MS = 15 * 60_000;

export interface WalkInInput {
  slotId: string | null;
  plate: string;
  vehicleType: string | null;
}

export interface WalkInPayload {
  slotId: string;
  plateNumber: string;
  vehicleType: WalkInVehicleType;
}

export interface WalkInErrors {
  slot?: 'required';
  plate?: 'empty' | PlateProblem;
  vehicleType?: 'required';
}

export type WalkInCheck = { ok: true; payload: WalkInPayload } | { ok: false; errors: WalkInErrors };

function isVehicleType(value: string | null): value is WalkInVehicleType {
  return value !== null && (VEHICLE_TYPES as readonly string[]).includes(value);
}

/** Mirrors the server rules for instant feedback; the server stays authoritative. */
export function validateWalkIn(input: WalkInInput): WalkInCheck {
  const errors: WalkInErrors = {};
  if (input.slotId === null || !isUuid(input.slotId)) errors.slot = 'required';
  if (!isVehicleType(input.vehicleType)) errors.vehicleType = 'required';
  const plate = input.plate.trim() === '' ? null : validatePlate(input.plate);
  if (plate === null) errors.plate = 'empty';
  else if (!plate.ok) errors.plate = plate.reason;

  if (Object.keys(errors).length > 0 || input.slotId === null || !isVehicleType(input.vehicleType) || plate === null || !plate.ok) {
    return { ok: false, errors };
  }
  return { ok: true, payload: { slotId: input.slotId, plateNumber: plate.plate, vehicleType: input.vehicleType } };
}

/**
 * FREE slots that fit the vehicle (when chosen) and have no booking starting within the gap.
 * Server order (floor, zone, code) is kept.
 */
export function selectableSlots(slots: readonly MapSlot[], vehicleType: string | null, nowMs: number): MapSlot[] {
  const allowed = vehicleType === null ? null : allowedSlotTypes(vehicleType);
  return slots.filter((slot) => {
    if (slot.status !== 'FREE') return false;
    if (allowed !== null && (slot.type === 'unknown' || !allowed.includes(slot.type))) return false;
    return slot.next === null || slot.next.startMs - nowMs >= WALK_IN_MIN_GAP_MS;
  });
}

/** "Keyingi bo'sh": the first selectable slot, or null. */
export function nextFreeSlot(slots: readonly MapSlot[], vehicleType: string | null, nowMs: number): MapSlot | null {
  return selectableSlots(slots, vehicleType, nowMs)[0] ?? null;
}
