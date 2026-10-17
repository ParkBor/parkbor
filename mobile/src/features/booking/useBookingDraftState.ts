import { useState } from 'react';

import {
  createDraft,
  selectSlotType,
  selectVehicle,
  type BookingDraft,
} from '@/features/booking/bookingDraft';
import { defaultSlotType } from '@/features/booking/vehicleSlotCompat';
import type { SlotType } from '@/features/map/schemas';
import type { Vehicle } from '@/features/vehicles/schemas';

/** The vehicle to use: the user's pick, else the only vehicle there is, else none (a deleted pick is dropped). */
function chooseVehicle(draft: BookingDraft, vehicles: readonly Vehicle[]): Vehicle | null {
  const picked = vehicles.find((vehicle) => vehicle.id === draft.vehicleId);
  return picked ?? (vehicles.length === 1 ? (vehicles[0] ?? null) : null);
}

/** Applies the chosen vehicle to the draft; the spot type follows the vehicle until the user picks one. */
function applyVehicle(draft: BookingDraft, chosen: Vehicle | null, isSlotTouched: boolean): BookingDraft {
  if (draft.vehicleId === (chosen?.id ?? null)) return draft;
  if (chosen === null) return selectVehicle(draft, null);
  const base = isSlotTouched ? draft : selectSlotType(draft, defaultSlotType(chosen.type));
  return selectVehicle(base, chosen);
}

export interface DraftState {
  draft: BookingDraft;
  chosen: Vehicle | null;
  change: (next: BookingDraft) => void;
  pickSlotType: (slotType: SlotType) => void;
  pickVehicle: (vehicle: Vehicle) => void;
  useMatchingSlotType: () => void;
}

/** Form state of the booking screen: the draft plus the vehicle / spot-type interplay. */
export function useBookingDraftState(nowMs: number, vehicles: readonly Vehicle[], preselected: SlotType | undefined): DraftState {
  const [stored, setStored] = useState<BookingDraft>(() => createDraft(nowMs, preselected));
  const [isSlotTouched, setIsSlotTouched] = useState(false);
  const chosen = chooseVehicle(stored, vehicles);
  const draft = applyVehicle(stored, chosen, isSlotTouched);

  return {
    draft,
    chosen,
    change: setStored,
    pickSlotType: (slotType) => {
      setIsSlotTouched(true);
      setStored(selectSlotType(draft, slotType));
    },
    pickVehicle: (vehicle) => setStored(applyVehicle(draft, vehicle, isSlotTouched)),
    useMatchingSlotType: () => {
      if (chosen) setStored(selectSlotType(draft, defaultSlotType(chosen.type)));
    },
  };
}
