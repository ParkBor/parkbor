import type { OperatorLot } from '@/features/operator/operatorSchemas';
import { validatePlate } from '@/features/vehicles/vehiclePlate';

export interface LotCapabilities {
  canCheckIn: boolean;
  canWalkIn: boolean;
  canSetSlotStatus: boolean;
  /** Exit works in every lot state: a car inside must always be able to leave (ARCHITECTURE 9.2). */
  canCheckOut: boolean;
  /** i18n key explaining why something is disabled; null when everything works. */
  notice: string | null;
}

/**
 * Check-in, walk-in and manual slot status need an ACTIVE lot; exit, cash settlement and reading
 * the map work in SUSPENDED / PENDING_REVIEW lots too. An unknown status fails closed for entry.
 */
export function lotCapabilities(lot: OperatorLot | null): LotCapabilities {
  if (lot === null) {
    return { canCheckIn: false, canWalkIn: false, canSetSlotStatus: false, canCheckOut: false, notice: 'operator.lot.none' };
  }
  if (lot.status === 'ACTIVE') {
    return { canCheckIn: true, canWalkIn: true, canSetSlotStatus: true, canCheckOut: true, notice: null };
  }
  const notice =
    lot.status === 'SUSPENDED' ? 'operator.lot.suspended' : lot.status === 'PENDING_REVIEW' ? 'operator.lot.pending_review' : 'operator.lot.inactive';
  return { canCheckIn: false, canWalkIn: false, canSetSlotStatus: false, canCheckOut: true, notice };
}

export interface PlateCheck {
  enabled: boolean;
  /** The lot requires it (`require_plate_on_checkin`): the operator cannot switch it off. */
  locked: boolean;
}

/**
 * Plate check at entry. Decision: the operator's per-lot switch is OFF by default (the big plate
 * on the check-in card is always compared by eye); a lot that sets `require_plate_on_checkin`
 * forces it on and the switch is locked.
 */
export function effectivePlateCheck(lot: OperatorLot | null, userToggle: boolean): PlateCheck {
  if (lot?.requirePlateOnCheckin === true) return { enabled: true, locked: true };
  return { enabled: userToggle, locked: false };
}

export type EntryPlate = { ok: true; plate: string | null } | { ok: false; reason: 'empty' | 'length' | 'charset' | 'mix' | 'ascii' };

/** The `plate_number` to send with a check-in; with the check on, an invalid plate blocks scanning. */
export function resolveEntryPlate(check: PlateCheck, raw: string): EntryPlate {
  if (!check.enabled) return { ok: true, plate: null };
  if (raw.trim() === '') return { ok: false, reason: 'empty' };
  const result = validatePlate(raw);
  return result.ok ? { ok: true, plate: result.plate } : { ok: false, reason: result.reason };
}
