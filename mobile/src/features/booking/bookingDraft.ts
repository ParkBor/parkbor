import type { CreateBookingPayload } from '@/features/booking/idempotencyKey';
import {
  clampDuration,
  defaultSelection,
  endFromDuration,
  startOfDay,
  startOptions,
  STEP_MIN,
  validatePeriod,
  type DayChoice,
  type PeriodProblem,
  type WorkingHours,
} from '@/features/booking/timeSlots';
import { checkVehicleSlot } from '@/features/booking/vehicleSlotCompat';
import type { SlotType } from '@/features/map/schemas';
import type { PaymentProvider } from '@/features/payment/providerChoice';
import { isUuid } from '@/lib/contract';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** The booking form state. Plain data, replaced (never mutated) by the functions below. */
export interface BookingDraft {
  day: DayChoice;
  startMs: number;
  endMs: number;
  slotType: SlotType;
  vehicleId: string | null;
}

export type DraftProblem = PeriodProblem | 'no_vehicle' | 'vehicle_slot_mismatch';

export interface DraftVehicle {
  id: string;
  type: string;
}

export function draftDurationMin(draft: Pick<BookingDraft, 'startMs' | 'endMs'>): number {
  return Math.round((draft.endMs - draft.startMs) / MINUTE_MS);
}

export function createDraft(nowMs: number, slotType: SlotType = 'STANDARD'): BookingDraft {
  const selection = defaultSelection(nowMs);
  const day: DayChoice = startOfDay(selection.startMs) === startOfDay(nowMs) ? 'today' : 'tomorrow';
  return { day, ...selection, slotType, vehicleId: null };
}

/** New start, same duration. */
export function selectStart(draft: BookingDraft, startMs: number): BookingDraft {
  return { ...draft, startMs, endMs: endFromDuration(startMs, draftDurationMin(draft)) };
}

/** Switch day keeping the clock time (snapped to the first free step if it is already past) and the duration. */
export function selectDay(draft: BookingDraft, day: DayChoice, nowMs: number): BookingDraft {
  if (day === draft.day) return draft;
  const options = startOptions(day, nowMs);
  const first = options[0];
  if (first === undefined) return draft;
  const clockMs = draft.startMs - startOfDay(draft.startMs);
  const candidate = startOfDay(first) + clockMs;
  const startMs = candidate >= first && candidate < startOfDay(first) + DAY_MS ? candidate : first;
  return { ...selectStart(draft, startMs), day };
}

export function applyQuickDuration(draft: BookingDraft, minutes: number): BookingDraft {
  return { ...draft, endMs: endFromDuration(draft.startMs, clampDuration(minutes)) };
}

export function adjustDuration(draft: BookingDraft, deltaMin: number): BookingDraft {
  const step = Math.sign(deltaMin) * STEP_MIN * Math.max(1, Math.round(Math.abs(deltaMin) / STEP_MIN));
  return applyQuickDuration(draft, draftDurationMin(draft) + step);
}

export function selectSlotType(draft: BookingDraft, slotType: SlotType): BookingDraft {
  return { ...draft, slotType };
}

/** Stores the id only. A mismatching slot type is reported by draftProblems, never changed silently. */
export function selectVehicle(draft: BookingDraft, vehicle: DraftVehicle | null): BookingDraft {
  return { ...draft, vehicleId: vehicle?.id ?? null };
}

/** Everything that would make the server refuse, found before sending. Empty = ready. */
export function draftProblems(
  draft: BookingDraft,
  vehicle: DraftVehicle | null,
  nowMs: number,
  hours: WorkingHours | null,
): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const period = validatePeriod({ startMs: draft.startMs, endMs: draft.endMs, nowMs, hours });
  if (!period.ok) problems.push(period.code);
  if (vehicle === null) problems.push('no_vehicle');
  else if (!checkVehicleSlot(vehicle.type, draft.slotType)) problems.push('vehicle_slot_mismatch');
  return problems;
}

/** null until a vehicle is chosen and the lot id is a UUID. */
export function toPayload(
  draft: BookingDraft,
  parkingLotId: string,
  paymentProvider: PaymentProvider | null = null,
): CreateBookingPayload | null {
  if (draft.vehicleId === null || !isUuid(parkingLotId)) return null;
  return {
    parkingLotId,
    slotType: draft.slotType,
    vehicleId: draft.vehicleId,
    startMs: draft.startMs,
    endMs: draft.endMs,
    preferredSlotId: null,
    paymentProvider,
  };
}
